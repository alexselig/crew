import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e'
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // stderr inherited: a real git failure in an ordinary call must still be
    // visible in test output.
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...ENV }
  }).trim()
}

// Used only at call sites where the git command is expected to fail as part
// of the assertion itself, so its stderr never reaches test output.
function gitExpectFailure(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ENV }
  })
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body)
  git(['add', '.'], cwd)
  git(['commit', '-m', message], cwd)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-merge-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  commit(repo, 'README.md', 'base\n', 'base')
  git(['branch', 'crew/integration'], repo)
  settings = {
    repo,
    integrationBranch: 'crew/integration',
    integrationWorktree: join(root, 'integration'),
    lanesDir: join(root, 'lanes'),
    maxLanes: 2,
    test: null
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('mergeInIntegration', () => {
  it('fast-forwards when the base is an ancestor of the candidate', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const result = await lanes.mergeInIntegration(tip, base)

    expect(result).toMatchObject({ ok: true, fastForward: true })
    if (result.ok) expect(result.resultSha).toBe(tip)
  })

  it('creates a merge commit when both sides moved', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'a.txt', 'A\n', 'a work')
    commit(b.worktree, 'b.txt', 'B\n', 'b work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch as string], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch as string], settings.repo),
      first.resultSha
    )
    expect(second).toMatchObject({ ok: true, fastForward: false })
    if (second.ok) {
      const parents = git(['rev-list', '--parents', '-n', '1', second.resultSha], settings.repo).split(' ')
      expect(parents).toHaveLength(3)
    }
  })

  // The lock is never held across a conflict, so the merge must leave no
  // MERGE_HEAD behind for the next publication to trip over.
  it('aborts a conflicted merge, names the paths, and leaves no merge state', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'shared.txt', 'from A\n', 'a work')
    commit(b.worktree, 'shared.txt', 'from B\n', 'b work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch as string], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch as string], settings.repo),
      first.resultSha
    )
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.conflictPaths).toContain('shared.txt')
    expect(existsSync(join(settings.integrationWorktree, '.git'))).toBe(true)
    const status = git(['status', '--porcelain'], settings.integrationWorktree)
    expect(status).toBe('')
  })

  it('keeps the integration worktree detached after merging', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    await lanes.mergeInIntegration(git(['rev-parse', lane.branch as string], settings.repo), base)
    expect(() => gitExpectFailure(['symbolic-ref', 'HEAD'], settings.integrationWorktree)).toThrow()
  })

  // A non-conflict git failure (here: an unresolvable revision) must never
  // be misreported as "the lane conflicts" — it has to propagate as a real
  // error so the caller does not treat it as something a human resolves by
  // editing files.
  it('propagates a genuine git failure instead of reporting a conflict', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    await expect(lanes.mergeInIntegration('not-a-real-revision', base)).rejects.toThrow(/git merge/)
  })
})

describe('syncLane', () => {
  // Without a way back, a lane edits stale code indefinitely and semantic
  // conflicts become the normal case rather than the exception.
  it('brings the integration branch into the lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    // Land something on integration that the lane has never seen.
    const other = await lanes.create('other', { presetId: 'shell', model: null })
    commit(other.worktree, 'other.txt', 'O\n', 'other work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const merged = await lanes.mergeInIntegration(
      git(['rev-parse', other.branch as string], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    git(['update-ref', 'refs/heads/crew/integration', merged.resultSha], settings.repo)

    expect(existsSync(join(lane.worktree, 'other.txt'))).toBe(false)
    const result = await lanes.syncLane(lane, merged.resultSha)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(lane.worktree, 'other.txt'), 'utf8')).toBe('O\n')
    expect((await lanes.facts(lane)).behind).toBe(0)
  })

  it('aborts and reports paths when a sync conflicts', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const other = await lanes.create('other', { presetId: 'shell', model: null })
    commit(lane.worktree, 'shared.txt', 'lane\n', 'lane work')
    commit(other.worktree, 'shared.txt', 'other\n', 'other work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const merged = await lanes.mergeInIntegration(
      git(['rev-parse', other.branch as string], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    git(['update-ref', 'refs/heads/crew/integration', merged.resultSha], settings.repo)

    const result = await lanes.syncLane(lane, merged.resultSha)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflictPaths).toContain('shared.txt')
    expect(git(['status', '--porcelain'], lane.worktree)).toBe('')
  })

  // A reviewer lane is detached at a candidate SHA and owns no branch;
  // syncing it in place would strand commits nothing ever tracks.
  it('rejects syncing a branchless (reviewer) lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const authored = await lanes.create('builder', { presetId: 'shell', model: null })
    const reviewerLane = { ...authored, kind: 'reviewer' as const, branch: null }
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    await expect(lanes.syncLane(reviewerLane, base)).rejects.toThrow(/builder/)
    await expect(lanes.syncLane(reviewerLane, base)).rejects.toThrow(/branch/i)
  })
})
