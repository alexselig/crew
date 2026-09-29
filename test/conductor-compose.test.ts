import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
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
    ]
  }
}

describe('composeRun', () => {
  it('creates a lane and a session per row, and reports them in order', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn(async (req: { cwd: string }) => ({ id: `sess-${req.cwd.split('/').pop()}` }))
    const result = await composeRun({ lanes, settings, createSession }, draft())

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
    await composeRun({ lanes, settings, createSession }, draft())
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the integration worktree once, detached', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn(async () => ({ id: 'sess' }))
    await composeRun({ lanes, settings, createSession }, draft())
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
    const result = await composeRun({ lanes, settings, createSession }, bad)

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
    const result = await composeRun({ lanes, settings, createSession }, draft())

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
    const result = await composeRun({ lanes, settings, createSession }, draft())
    expect(result).toMatchObject({ ok: false, failedRow: 0 })
    expect(existsSync(join(settings.lanesDir, 'builder'))).toBe(false)
  })

  it('reports the underlying failure rather than a generic one', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn().mockRejectedValue(new Error('preset not installed'))
    const result = await composeRun({ lanes, settings, createSession }, draft())
    if (result.ok) throw new Error('expected failure')
    // Two failure shapes share `ok: false` (a rejected roster has no
    // `failedRow`); narrow to the row-failure variant before reading message.
    if (!('failedRow' in result)) throw new Error('expected a row failure')
    expect(result.message).toContain('preset not installed')
  })
})
