import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
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
    workspaceId: 'ws_1',
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

  // Task 5, finding 2 (fix round 1): workspaceId is required and validated
  // on a PERSISTED lane, even though it is optional on the ConductorLane
  // type itself — a record without one is unreachable by every workspace's
  // hydration, exactly the orphan this system exists to prevent. Dropped
  // per-record (like every other malformed lane field above), never
  // quarantining the whole store, and a valid sibling in the same load
  // must survive untouched.
  it('drops a lane with a missing, non-string or empty workspaceId, while a valid sibling survives', () => {
    const path = tmpStorePath()
    const good = makeLane({ id: 'lane_good', workspaceId: 'ws_good' })
    const missing = { ...makeLane({ id: 'lane_missing' }) } as Record<string, unknown>
    delete missing.workspaceId
    const emptyString = makeLane({ id: 'lane_empty', workspaceId: '' })
    const nonString = { ...makeLane({ id: 'lane_bad_type' }), workspaceId: 42 }
    seed(path, { conductorLanes: [good, missing, emptyString, nonString] })

    const store = new Store(path)
    expect(store.getConductorLanes()).toEqual([good])
  })

  it('persists conductor lanes so a restart never orphans the roster', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveConductorLanes([makeLane()])

    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.conductorLanes).toEqual([makeLane()])
  })

  it('drops a malformed lane element on load without quarantining the rest of the store', () => {
    // Distinct from Store's whole-array validators (workspaces, sessions,
    // etc.), which throw and quarantine the entire file if any one element
    // is invalid. A malformed lane element must only cost that one lane.
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

  it('defaults both collections to [] when the keys are absent (back-compat with a pre-existing store)', () => {
    const path = tmpStorePath()
    seed(path, { recentDirs: ['/some/dir'] })

    const store = new Store(path)
    expect(store.getConductorConfigs()).toEqual([])
    expect(store.getConductorLanes()).toEqual([])
  })

  it('recovers from .bak, rather than silently erasing the roster, when conductorLanes is present but not an array', () => {
    // A malformed *element* is dropped (see above), but a corrupt collection
    // — present, valid JSON, but not an array at all — is not "empty", it is
    // damaged. Treating it as [] would erase the roster and the very next
    // persist() would cement that loss. It must instead go through the same
    // invalid-store recovery path as every other Store collection.
    const path = tmpStorePath()
    const lane = makeLane()
    const store = new Store(path)
    store.saveConductorLanes([lane])
    store.saveConductorLanes([lane]) // second save leaves a good .bak behind

    const corrupted = JSON.parse(readFileSync(path, 'utf8'))
    corrupted.conductorLanes = 'not-an-array'
    writeFileSync(path, JSON.stringify(corrupted))

    const reopened = new Store(path)
    expect(reopened.getConductorLanes()).toEqual([lane])
    // The corrupt live file is preserved for inspection, not silently discarded.
    const preserved = existsSync(path) && JSON.parse(readFileSync(path, 'utf8'))
    expect(preserved.conductorLanes).toEqual([lane])
  })
})
