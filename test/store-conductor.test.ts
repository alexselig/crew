import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { ConductorConfig, ConductorLane } from '../src/shared/conductor'

const temporaryDirs: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-store-conductor-'))
  temporaryDirs.push(dir)
  return join(dir, 'store.json')
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data))
}

function makeConfig(overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    workspaceId: 'ws_1',
    repo: '/repo',
    integrationBranch: 'crew/integration',
    integrationWorktree: '/repo/.crew/integration',
    lanesDir: '/repo/.crew/lanes',
    maxLanes: 3,
    test: null,
    ...overrides
  }
}

function makeLane(overrides: Partial<ConductorLane> = {}): ConductorLane {
  return {
    id: 'lane_1',
    roleId: 'author-1',
    kind: 'author',
    agent: { presetId: 'copilot-cli', model: null },
    worktree: '/repo/.crew/lanes/author-1',
    branch: 'crew/author-1',
    sessionId: null,
    status: 'working',
    dispatches: 0,
    ...overrides
  }
}

describe('Store — conductor configs', () => {
  it('round-trips conductor configs through save and reload', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    const config = makeConfig()

    store.saveConductorConfigs([config])
    expect(store.getConductorConfigs()).toEqual([config])

    const reloaded = new Store(path)
    expect(reloaded.getConductorConfigs()).toEqual([config])
  })

  it('drops a malformed conductor config on load instead of coercing it', () => {
    const path = tmpStorePath()
    const good = makeConfig({ workspaceId: 'ws_good' })
    const bad = { ...makeConfig({ workspaceId: 'ws_bad' }), repo: '' }
    seed(path, { conductorConfigs: [good, bad] })

    const store = new Store(path)
    expect(store.getConductorConfigs()).toEqual([good])
  })
})

describe('Store — conductor lanes', () => {
  it('round-trips conductor lanes through save and reload', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    const lane = makeLane()

    store.saveConductorLanes([lane])
    expect(store.getConductorLanes()).toEqual([lane])

    const reloaded = new Store(path)
    expect(reloaded.getConductorLanes()).toEqual([lane])
  })

  it('drops a lane with an empty id, worktree or branch on load instead of coercing it', () => {
    const path = tmpStorePath()
    const good = makeLane({ id: 'lane_good' })
    const emptyId = makeLane({ id: '' })
    const emptyWorktree = makeLane({ id: 'lane_bad_worktree', worktree: '' })
    const emptyBranch = makeLane({ id: 'lane_bad_branch', branch: '' })
    seed(path, { conductorLanes: [good, emptyId, emptyWorktree, emptyBranch] })

    const store = new Store(path)
    expect(store.getConductorLanes()).toEqual([good])
  })

  it('keeps a reviewer lane with a null branch (branch is only malformed when empty, not null)', () => {
    const path = tmpStorePath()
    const reviewer = makeLane({ id: 'lane_reviewer', kind: 'reviewer', branch: null })
    seed(path, { conductorLanes: [reviewer] })

    const store = new Store(path)
    expect(store.getConductorLanes()).toEqual([reviewer])
  })

  it('persists conductor lanes so a restart never orphans the roster', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveConductorLanes([makeLane()])

    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.conductorLanes).toEqual([makeLane()])
  })

  it('does not touch an unrelated invalid workspaces entry\'s independent quarantine behaviour', () => {
    // Sanity check that conductor collections are validated per-record and do
    // not ride along with the whole-file quarantine used for other arrays.
    const path = tmpStorePath()
    const good = makeLane({ id: 'lane_ok' })
    const bad = makeLane({ id: '' })
    seed(path, {
      conductorLanes: [good, bad],
      recentDirs: ['/some/dir']
    })

    const store = new Store(path)
    expect(store.getConductorLanes()).toEqual([good])
    expect(store.recentDirs).toEqual(['/some/dir'])
  })
})
