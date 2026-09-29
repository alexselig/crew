import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // stderr is piped (not inherited) so an expected git failure, such as
    // `symbolic-ref` refusing a detached HEAD, never reaches test output.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' }
  }).trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-lanes-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'base'], repo)
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

describe('lane manager lifecycle', () => {
  it('creates an integration worktree whose HEAD is detached', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    expect(existsSync(settings.integrationWorktree)).toBe(true)
    // If HEAD sat on integrationBranch, update-ref would advance the ref and
    // leave this worktree's index behind it.
    expect(() => git(['symbolic-ref', 'HEAD'], settings.integrationWorktree)).toThrow()
    expect(git(['rev-parse', 'HEAD'], settings.integrationWorktree))
      .toBe(git(['rev-parse', 'crew/integration'], settings.repo))
  })

  it('leaves the integration branch checked out nowhere', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const list = git(['worktree', 'list', '--porcelain'], settings.repo)
    expect(list).not.toContain('branch refs/heads/crew/integration')
  })

  it('is idempotent when the integration worktree already exists', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    await expect(lanes.ensureIntegrationWorktree()).resolves.toBeUndefined()
  })

  it('creates a lane on its own branch, based on the integration branch', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'copilot-cli', model: 'claude-opus-5.5' })
    expect(lane.branch).toBe('crew/lane/builder')
    expect(existsSync(lane.worktree)).toBe(true)
    expect(lane.agent.model).toBe('claude-opus-5.5')
    expect(git(['rev-parse', lane.branch as string], settings.repo))
      .toBe(git(['rev-parse', 'crew/integration'], settings.repo))
  })

  it('reports ahead, behind and a clean tree for a fresh lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const facts = await lanes.facts(lane)
    expect(facts).toMatchObject({ ahead: 0, behind: 0, dirtyTracked: false, untracked: false })
    expect(facts.laneTip).toBe(facts.baseSha)
  })

  it('counts ahead commits and does not confuse them with behind', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'a.txt'), 'one\n')
    git(['add', '.'], lane.worktree)
    git(['commit', '-m', 'lane work'], lane.worktree)
    const facts = await lanes.facts(lane)
    expect(facts.ahead).toBe(1)
    expect(facts.behind).toBe(0)
  })

  // The spec demotes dirty to advisory precisely so a lane cannot stall
  // forever on coverage/ or .DS_Store.
  it('separates tracked modifications from untracked files', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'scratch.txt'), 'notes\n')
    let facts = await lanes.facts(lane)
    expect(facts.untracked).toBe(true)
    expect(facts.dirtyTracked).toBe(false)

    writeFileSync(join(lane.worktree, 'README.md'), 'changed\n')
    facts = await lanes.facts(lane)
    expect(facts.dirtyTracked).toBe(true)
  })

  it('refuses to destroy a lane with uncommitted changes unless forced', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'README.md'), 'changed\n')
    await expect(lanes.destroy(lane, { force: false })).rejects.toThrow(/uncommitted/i)
    expect(existsSync(lane.worktree)).toBe(true)
    await lanes.destroy(lane, { force: true })
    expect(existsSync(lane.worktree)).toBe(false)
  })

  it('destroys a clean lane without force', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    await lanes.destroy(lane, { force: false })
    expect(existsSync(lane.worktree)).toBe(false)
  })

  it('deletes the lane branch on destroy once its commits are merged, freeing the name for reuse', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'a.txt'), 'one\n')
    git(['add', '.'], lane.worktree)
    git(['commit', '-m', 'lane work'], lane.worktree)
    // Merge the lane's commit into integrationBranch so `branch -d` is safe.
    git(['fetch', lane.worktree, `${lane.branch}:crew/integration`], settings.repo)

    await lanes.destroy(lane, { force: false })

    expect(() => git(['rev-parse', '--verify', lane.branch as string], settings.repo)).toThrow()
    const recreated = await lanes.create('builder', { presetId: 'shell', model: null })
    expect(recreated.branch).toBe('crew/lane/builder')
  })

  it('keeps an unmerged lane branch after destroy, and destroy still resolves', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'a.txt'), 'one\n')
    git(['add', '.'], lane.worktree)
    git(['commit', '-m', 'unpublished work'], lane.worktree)
    const laneTip = git(['rev-parse', lane.branch as string], settings.repo)

    await expect(lanes.destroy(lane, { force: false })).resolves.toBeUndefined()

    expect(existsSync(lane.worktree)).toBe(false)
    expect(git(['rev-parse', lane.branch as string], settings.repo)).toBe(laneTip)
  })

  it('throws a domain error naming the lane when facts() is called on a branchless (reviewer) lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const authored = await lanes.create('builder', { presetId: 'shell', model: null })
    const reviewerLane = { ...authored, kind: 'reviewer' as const, branch: null }
    await expect(lanes.facts(reviewerLane)).rejects.toThrow(/builder/)
    await expect(lanes.facts(reviewerLane)).rejects.toThrow(/branch/i)
  })
})
