import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
