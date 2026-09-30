import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { LaneManager } from '../src/main/lanes'
import { composeRun } from '../src/main/conductor-compose'
import type { ConductorSettings } from '../src/shared/conductor'
import type { RosterDraft } from '../src/shared/conductor-composer'

let root: string
let settings: ConductorSettings

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-compose-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env: { ...process.env, ...ENV } })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, env: { ...process.env, ...ENV } })
  execFileSync('git', ['branch', 'crew/integration'], { cwd: repo })
  settings = {
    repo,
    integrationBranch: 'crew/integration',
    integrationWorktree: join(root, 'integration'),
    lanesDir: join(root, 'lanes'),
    maxLanes: 3,
    test: null
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function draft(): RosterDraft {
  return {
    repo: settings.repo,
    integrationBranch: settings.integrationBranch,
    rows: [
      { roleName: 'builder', kind: 'author', agent: { presetId: 'shell', model: null } },
      { roleName: 'scout', kind: 'author', agent: { presetId: 'shell', model: null } }
    ],
    test: null
  }
}

describe('composeRun', () => {
  it('creates a lane and a session per row, and reports them in order', async () => {
    const lanes = createLaneManager(settings)
    // basename(), not split('/'): on Windows the worktree path composeRun
    // hands the stub is separator-backslashed, so split('/').pop() returned
    // the whole path and the stub minted `sess-C:\…\lanes\builder`. The
    // assertion below is unchanged — it is the stub's lane-name derivation
    // that had to stop assuming POSIX separators.
    const createSession = vi.fn(async (req: { cwd: string }) => ({ id: `sess-${basename(req.cwd)}` }))
    const result = await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lanes.map((l) => l.roleId)).toEqual(['builder', 'scout'])
    expect(result.lanes.map((l) => l.sessionId)).toEqual(['sess-builder', 'sess-scout'])
    for (const lane of result.lanes) expect(existsSync(lane.worktree)).toBe(true)
  })

  // cwd is fixed at spawn and there is no setCwd, so the worktree must exist
  // before the session does.
  it('spawns each session with cwd set to its own lane worktree', async () => {
    const lanes = createLaneManager(settings)
    const seen: string[] = []
    const createSession = vi.fn(async (req: { cwd: string }) => {
      expect(existsSync(req.cwd)).toBe(true)
      seen.push(req.cwd)
      return { id: 'sess' }
    })
    await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the integration worktree once, detached', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn(async () => ({ id: 'sess' }))
    await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())
    expect(existsSync(settings.integrationWorktree)).toBe(true)
    // `symbolic-ref --quiet HEAD` exits non-zero (with empty stdout) exactly
    // when HEAD is detached, which is the thing under test — so a detached
    // HEAD makes execFileSync throw rather than return. Node's stdout is
    // still attached to the error in that case, and it's still empty.
    let head = ''
    try {
      head = execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: settings.integrationWorktree, encoding: 'utf8'
      }).trim()
    } catch (error) {
      head = (error as { stdout?: string }).stdout?.trim() ?? ''
    }
    expect(head).toBe('')
  })

  it('rejects an invalid roster without creating anything', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn()
    const bad = draft()
    bad.rows[1].roleName = 'builder'
    const result = await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, bad)

    expect(result.ok).toBe(false)
    expect(createSession).not.toHaveBeenCalled()
    expect(existsSync(settings.lanesDir)).toBe(false)
  })

  // A half-built run is worse than no run, because it looks finished.
  it('rolls every lane back when a later row fails to spawn', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn()
      .mockResolvedValueOnce({ id: 'sess-1' })
      .mockRejectedValueOnce(new Error('preset not installed'))
    const result = await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())

    expect(result).toMatchObject({ ok: false, failedRow: 1 })
    const branches = execFileSync('git', ['branch', '--list', 'crew/lane/*'], {
      cwd: settings.repo, encoding: 'utf8'
    }).trim()
    expect(branches).toBe('')
    const worktrees = execFileSync('git', ['worktree', 'list'], {
      cwd: settings.repo, encoding: 'utf8'
    })
    expect(worktrees).not.toContain('crew/lane/')
  })

  it('removes the lane it had just created when that row is the one that fails', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn().mockRejectedValue(new Error('spawn failed'))
    const result = await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())
    expect(result).toMatchObject({ ok: false, failedRow: 0 })
    expect(existsSync(join(settings.lanesDir, 'builder'))).toBe(false)
  })

  it('reports the underlying failure rather than a generic one', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn().mockRejectedValue(new Error('preset not installed'))
    const result = await composeRun({ lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() }, draft())
    if (result.ok) throw new Error('expected failure')
    // Two failure shapes share `ok: false` (a rejected roster has no
    // `failedRow`); narrow to the row-failure variant before reading message.
    if (!('failedRow' in result)) throw new Error('expected a row failure')
    expect(result.message).toContain('preset not installed')
  })

  // Row 1's session was already spawned with cwd pointed at the builder
  // lane's worktree. If rollback deleted that worktree without first tearing
  // down the session, the session would survive pointing at a directory that
  // no longer exists. Wrapping the real LaneManager's destroy lets this test
  // observe ordering without faking git.
  it("closes row 1's already-created session before removing its lane's worktree, so no session outlives its cwd", async () => {
    const order: string[] = []
    const realLanes = createLaneManager(settings)
    const lanes: LaneManager = {
      ...realLanes,
      destroy: async (lane, opts) => {
        order.push(`destroy-lane:${lane.roleId}`)
        return realLanes.destroy(lane, opts)
      }
    }
    const closeSession = vi.fn((id: string) => order.push(`close-session:${id}`))
    const createSession = vi.fn()
      .mockResolvedValueOnce({ id: 'sess-builder' })
      .mockRejectedValueOnce(new Error('preset not installed'))

    const result = await composeRun({ lanes, settings, createSession, closeSession, setTestRecipe: vi.fn() }, draft())

    expect(result).toMatchObject({ ok: false, failedRow: 1 })
    expect(closeSession).toHaveBeenCalledWith('sess-builder')
    expect(order).toEqual(['destroy-lane:scout', 'close-session:sess-builder', 'destroy-lane:builder'])
    expect(existsSync(join(settings.lanesDir, 'builder'))).toBe(false)
  })

  // Making a lane's own linked-worktree admin directory read-only forces its
  // `git worktree remove` to fail for real during rollback — the same
  // technique test/lanes-merge.test.ts uses to force a real write failure,
  // rather than a mock throwing where the real code would not.
  it('reports a lane rollback could not remove as a cleanup failure, instead of swallowing it', async () => {
    const lanes = createLaneManager(settings)
    let builderGitDir: string | undefined
    const createSession = vi.fn(async (req: { cwd: string }) => {
      if (req.cwd.endsWith('builder')) {
        const out = execFileSync('git', ['rev-parse', '--git-dir'], {
          cwd: req.cwd, encoding: 'utf8'
        }).trim()
        builderGitDir = isAbsolute(out) ? out : resolve(req.cwd, out)
        return { id: 'sess-builder' }
      }
      if (builderGitDir) chmodSync(builderGitDir, 0o500)
      throw new Error('preset not installed')
    })

    try {
      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() },
        draft()
      )
      expect(result.ok).toBe(false)
      if (result.ok || !('cleanupFailures' in result)) throw new Error('expected a row failure')
      expect(result.cleanupFailures).toContainEqual(
        expect.objectContaining({ resource: 'lane', id: 'builder' })
      )
      // Task 5, finding 3 (fix round 1): the lane rollback could not remove
      // must come back as a real ConductorLane, not merely be announced by
      // name — the backend needs the full object to register/persist it.
      expect(result.survivingLanes).toContainEqual(
        expect.objectContaining({ roleId: 'builder' })
      )
    } finally {
      // Must run even if an assertion above throws, or the temp dir left by
      // afterEach's rmSync becomes unremovable.
      if (builderGitDir) chmodSync(builderGitDir, 0o700)
    }
  })

  // If closeSession THROWS for a lane, its worktree must survive rather than
  // be deleted out from under the (still-live) session it failed to close —
  // that would recreate the exact orphan rollback exists to prevent. A
  // stuck session must also not stop rollback from cleaning up the OTHER
  // lanes, so this uses three rows and fails only the middle one's close.
  it('does not delete a lane whose session failed to close during rollback, and still cleans up the rest', async () => {
    const three: RosterDraft = {
      ...draft(),
      rows: [
        ...draft().rows,
        { roleName: 'referee', kind: 'author', agent: { presetId: 'shell', model: null } }
      ]
    }
    const lanes = createLaneManager(settings)
    const createSession = vi.fn()
      .mockResolvedValueOnce({ id: 'sess-builder' })
      .mockResolvedValueOnce({ id: 'sess-scout' })
      .mockRejectedValueOnce(new Error('preset not installed'))
    const closeSession = vi.fn((id: string) => {
      if (id === 'sess-scout') throw new Error('session would not die')
    })

    const result = await composeRun({ lanes, settings, createSession, closeSession, setTestRecipe: vi.fn() }, three)

    expect(result.ok).toBe(false)
    if (result.ok || !('cleanupFailures' in result)) throw new Error('expected a row failure')
    expect(result.cleanupFailures).toContainEqual(
      expect.objectContaining({ resource: 'session', id: 'sess-scout' })
    )
    // scout's worktree must survive: its session failed to close, so
    // deleting it now would orphan a session still pointed at this cwd.
    expect(existsSync(join(settings.lanesDir, 'scout'))).toBe(true)
    // builder's session closed fine, so its lane must still be cleaned up —
    // scout's stuck session must not strand the rest of rollback.
    expect(existsSync(join(settings.lanesDir, 'builder'))).toBe(false)
    // Task 5, finding 3 (fix round 1): scout's surviving worktree must be
    // reported as a real lane the backend can register/persist; builder's
    // lane is genuinely gone and must NOT appear here.
    expect(result.survivingLanes).toContainEqual(expect.objectContaining({ roleId: 'scout' }))
    expect(result.survivingLanes.some((l) => l.roleId === 'builder')).toBe(false)
  })

  // The app has no repository concept of its own; the composer draft is the
  // only source of truth for which repo/branch a run means. A draft aimed
  // at some other repo than the one the runtime is wired to is exactly the
  // silent wrong-target bug review finding 4 flagged — reject it instead of
  // quietly using runtime.settings' repo.
  describe('rejects a draft that does not match the wired runtime', () => {
    it('rejects a different repo, creating nothing', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn()
      const otherRepo = join(root, 'elsewhere')
      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() },
        { ...draft(), repo: otherRepo }
      )

      expect(result).toMatchObject({
        ok: false,
        errors: [{ field: 'repo', message: expect.any(String) }]
      })
      expect(createSession).not.toHaveBeenCalled()
      expect(existsSync(settings.integrationWorktree)).toBe(false)
      expect(existsSync(settings.lanesDir)).toBe(false)
    })

    // A trailing slash or a "./" segment names the exact same directory, so
    // it must not be treated as a different repository.
    it('accepts the same repo written with a trailing slash', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn(async () => ({ id: 'sess' }))
      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() },
        { ...draft(), repo: `${settings.repo}${settings.repo.endsWith('/') ? '' : '/'}` }
      )
      expect(result.ok).toBe(true)
    })

    it('rejects a different integration branch, creating nothing', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn()
      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() },
        { ...draft(), integrationBranch: 'crew/other' }
      )

      expect(result).toMatchObject({
        ok: false,
        errors: [{ field: 'integrationBranch', message: expect.any(String) }]
      })
      expect(createSession).not.toHaveBeenCalled()
      expect(existsSync(settings.integrationWorktree)).toBe(false)
    })
  })

  describe('the test recipe', () => {
    it('is handed to setTestRecipe only once the whole run has succeeded', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn(async () => ({ id: 'sess' }))
      const setTestRecipe = vi.fn()
      const recipe = { command: 'npm', args: ['test'], cwd: '.', timeoutMs: 10_000 }

      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe },
        { ...draft(), test: recipe }
      )

      expect(result.ok).toBe(true)
      expect(setTestRecipe).toHaveBeenCalledTimes(1)
      expect(setTestRecipe).toHaveBeenCalledWith(recipe)
    })

    it('is left untouched when the roster is rejected outright', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn()
      const setTestRecipe = vi.fn()
      const bad = { ...draft(), test: { command: 'npm', args: [], cwd: '.', timeoutMs: 1000 } }
      bad.rows[1].roleName = 'builder'

      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe },
        bad
      )

      expect(result.ok).toBe(false)
      expect(setTestRecipe).not.toHaveBeenCalled()
    })

    it('is left untouched when a row fails partway through and rollback runs', async () => {
      const lanes = createLaneManager(settings)
      const createSession = vi.fn()
        .mockResolvedValueOnce({ id: 'sess-1' })
        .mockRejectedValueOnce(new Error('preset not installed'))
      const setTestRecipe = vi.fn()

      const result = await composeRun(
        { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe },
        { ...draft(), test: { command: 'npm', args: [], cwd: '.', timeoutMs: 1000 } }
      )

      expect(result).toMatchObject({ ok: false, failedRow: 1 })
      expect(setTestRecipe).not.toHaveBeenCalled()
    })
  })
}, { timeout: 30_000 })

// Review finding 6: composeRun reaches main over IPC, and a throw there
// becomes a rejected invoke() the renderer had no catch for — the composer
// spinner simply stopped and the user was told nothing. The things that
// throw here are entirely ordinary (a repo that is not a git repository, an
// integration branch that does not exist, a path realpath cannot resolve),
// so they are refusals and must be returned as such.
describe('composeRun: a failure the user can act on, never a rejected promise', () => {
  it('returns a structured repo error instead of throwing when the integration worktree cannot be prepared', async () => {
    const lanes = createLaneManager({ ...settings, integrationBranch: 'crew/does-not-exist' })
    const createSession = vi.fn()
    const result = await composeRun(
      { lanes, settings, createSession, closeSession: vi.fn(), setTestRecipe: vi.fn() },
      { ...draft(), integrationBranch: settings.integrationBranch }
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('errors' in result && result.errors[0]?.field).toBe('repo')
    expect('errors' in result && result.errors[0]?.message).toContain('integration worktree')
    // Nothing was created: the failure happened before the first row.
    expect(createSession).not.toHaveBeenCalled()
  })

  it('returns a structured repo error instead of throwing when the draft repo path cannot be resolved at all', async () => {
    const unreadable = join(root, 'unreadable')
    execFileSync('mkdir', [unreadable])
    chmodSync(unreadable, 0o000)
    try {
      const lanes = createLaneManager(settings)
      const result = await composeRun(
        { lanes, settings, createSession: vi.fn(), closeSession: vi.fn(), setTestRecipe: vi.fn() },
        { ...draft(), repo: join(unreadable, 'inner', 'repo') }
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      // Either arm is a refusal the composer can render: samePath may fail
      // closed (its own error) or simply prove the paths differ. What must
      // never happen is a throw.
      expect('errors' in result && result.errors.some((e) => e.field === 'repo')).toBe(true)
    } finally {
      chmodSync(unreadable, 0o700)
    }
  })
})
