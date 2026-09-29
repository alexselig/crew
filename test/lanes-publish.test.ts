import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings, ConductorLane } from '../src/shared/conductor'

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

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body)
  git(['add', '.'], cwd)
  git(['commit', '-m', message], cwd)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-publish-'))
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

/** Merge a lane's tip into the current integration ref and CAS it into place. */
async function publishLane(lanes: ReturnType<typeof createLaneManager>, lane: ConductorLane) {
  const base = git(['rev-parse', 'crew/integration'], settings.repo)
  const tip = git(['rev-parse', lane.branch as string], settings.repo)
  const merged = await lanes.mergeInIntegration(tip, base)
  if (!merged.ok) throw new Error(`merge failed: ${merged.message}`)
  return lanes.publish(merged.resultSha, base)
}

describe('publish', () => {
  it('advances the integration ref and reports the touched paths', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const result = await publishLane(lanes, lane)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.touchedPaths).toEqual(['a.txt'])
      expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(result.commit)
    }
  })

  // External mutation must stop and surface, never blind-retry.
  it('refuses when the ref has moved underneath it', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const stale = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, stale)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    // Someone else moves the branch between the merge and the CAS.
    commit(settings.repo, 'outside.txt', 'X\n', 'outside work')
    git(['update-ref', 'refs/heads/crew/integration', git(['rev-parse', 'HEAD'], settings.repo)], settings.repo)

    const result = await lanes.publish(merged.resultSha, stale)
    expect(result).toMatchObject({ ok: false, reason: 'ref-moved' })
  })

  // The CAS itself can fail for reasons that have nothing to do with the ref
  // having moved (a malformed new value, for instance). That must be
  // distinguished from 'ref-moved', and the ref must stay untouched: a
  // rejected CAS never gets to write anything.
  it('reports reason "error" when the CAS fails for a reason other than the ref moving', async () => {
    const lanes = createLaneManager(settings)
    const before = git(['rev-parse', 'crew/integration'], settings.repo)

    const result = await lanes.publish('not-a-real-revision', before)

    expect(result).toMatchObject({ ok: false, reason: 'error' })
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
  })

  // THE TORN-WRITE REGRESSION TEST. The CAS had already advanced the ref by
  // the time the post-CAS `git diff` step ran; if that step fails, the ref
  // must not be left sitting on the new value while publish() reports
  // failure. Corrupting the new commit's tree object (deleting its real
  // object file) makes `git diff` genuinely fail with no object to read,
  // without touching any permission bit — the CAS itself never needs that
  // tree, only the commit object, so it still succeeds.
  it('rolls the ref back and propagates the original failure when the post-CAS step throws', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, base)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    const tree = git(['rev-parse', `${merged.resultSha}^{tree}`], settings.repo)
    rmSync(join(settings.repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))

    await expect(lanes.publish(merged.resultSha, base)).rejects.toThrow(/tree/i)
    // The CAS had already moved the ref to merged.resultSha; the rollback
    // must have put it back exactly where it started.
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(base)
  })

  // THE DOUBLE-FAILURE REGRESSION TEST. If the rollback itself also fails,
  // publish() must not silently swallow one half: it has to throw a single
  // composite error naming both the original post-CAS failure and the
  // rollback failure, and flag the ref for manual attention, because at that
  // point the ref is left wherever the failed rollback left it — nothing
  // automated can fix it further. Deleting the BASE commit object (not the
  // tree) drives both failures from one root cause: the CAS itself only
  // checks the ref's stored value against expectedOld, not object
  // reachability, so it still succeeds; the post-CAS `git diff` then fails
  // because expectedOld no longer resolves to anything; and the rollback
  // `update-ref <ref> <expectedOld> <newSha>` fails for the exact same
  // reason, since update-ref refuses to point a ref at a nonexistent object.
  it('throws one composite error when the rollback itself also fails', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, base)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    const objectsDir = git(['rev-parse', '--git-path', 'objects'], settings.repo)
    const baseObject = join(settings.repo, objectsDir, base.slice(0, 2), base.slice(2))
    expect(existsSync(baseObject)).toBe(true) // confirm it is loose before deleting it
    rmSync(baseObject)

    let thrown: Error | undefined
    try {
      await lanes.publish(merged.resultSha, base)
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    const message = thrown!.message
    // Half one: the original post-CAS `git diff` failure.
    expect(message).toMatch(/git diff --name-only|bad object/i)
    // Half two: the rollback's own failure.
    expect(message).toMatch(/nonexistent object|update.ref/i)
    expect(message).toMatch(/manual attention/i)

    // The CAS had already advanced the ref, and the rollback could not
    // possibly succeed (it needs the very object that was deleted), so the
    // ref must be left sitting on merged.resultSha, not rolled back.
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(merged.resultSha)
  })

  // git only refuses a checkout when another worktree holds the branch as
  // HEAD, so this check is what keeps the user free to check it out themselves.
  it('refuses when a worktree has the integration branch checked out', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, base)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    git(['worktree', 'add', join(root, 'user-checkout'), 'crew/integration'], settings.repo)
    const result = await lanes.publish(merged.resultSha, base)
    expect(result).toMatchObject({ ok: false, reason: 'branch-checked-out' })
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(base)
  })

  // THE REGRESSION TEST. Publishing by rebase left the lane branch pointing at
  // the original commits, so `ahead` never returned to 0 and the next
  // publication replayed the lane's own landed commits against themselves.
  it('lets one lane publish twice in a row, resetting ahead each time', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    commit(lane.worktree, 'a.txt', 'one\n', 'first')
    expect((await lanes.facts(lane)).ahead).toBe(1)
    const first = await publishLane(lanes, lane)
    expect(first.ok).toBe(true)
    expect((await lanes.facts(lane)).ahead).toBe(0)

    commit(lane.worktree, 'a.txt', 'two\n', 'second')
    expect((await lanes.facts(lane)).ahead).toBe(1)
    const second = await publishLane(lanes, lane)
    expect(second.ok).toBe(true)
    expect((await lanes.facts(lane)).ahead).toBe(0)
    // Exactly the two lane commits landed, neither replayed.
    const log = git(['log', '--format=%s', 'crew/integration'], settings.repo).split('\n')
    expect(log.filter((s) => s === 'first')).toHaveLength(1)
    expect(log.filter((s) => s === 'second')).toHaveLength(1)
  })

  // The scenario the feature exists for, and the one rebase broke: two lanes
  // both landing, repeatedly.
  it('lets two lanes publish alternately without replaying each other', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })

    commit(a.worktree, 'a.txt', 'A1\n', 'a1')
    expect((await publishLane(lanes, a)).ok).toBe(true)

    commit(b.worktree, 'b.txt', 'B1\n', 'b1')
    expect((await publishLane(lanes, b)).ok).toBe(true)

    // a must be able to sync and publish again with no conflict against itself.
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    expect((await lanes.syncLane(a, base)).ok).toBe(true)
    commit(a.worktree, 'a.txt', 'A2\n', 'a2')
    expect((await publishLane(lanes, a)).ok).toBe(true)

    const log = git(['log', '--format=%s', 'crew/integration'], settings.repo)
    for (const subject of ['a1', 'b1', 'a2']) {
      expect(log.split('\n').filter((s) => s === subject)).toHaveLength(1)
    }
  })
})
