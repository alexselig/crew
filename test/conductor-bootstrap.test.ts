import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { findAll, findCallsTo, flattenPropertyAccess, hasNamedImport, parseSource } from './helpers/ts-ast'
import {
  createConductorController,
  DEFAULT_MAX_LANES,
  type ConductorBootstrapDeps
} from '../src/main/conductor-bootstrap'
import type { ConductorConfig, ConductorLane, TestRecipe } from '../src/shared/conductor'
import type { ConductorRuntime, ConductorBackend, ConductorPersistence } from '../src/main/conductor-ipc'
import { ConductorBusyError } from '../src/main/conductor'
import { MalformedJournalError } from '../src/shared/conductor-recovery'

const USER_DATA_DIR = '/Users/test/Library/Application Support/Crew'

/** A minimal fake ConductorRuntime, distinguishable per workspace via its
 *  settings.repo, so tests can prove which runtime a given backend call
 *  actually reached without depending on real git/lanes plumbing. */
function fakeRuntime(overrides: Partial<ConductorRuntime> = {}): ConductorRuntime {
  return {
    lanes: {
      ensureIntegrationWorktree: vi.fn(async () => undefined),
      create: vi.fn(async () => {
        throw new Error('not used in these tests')
      }),
      facts: vi.fn(async () => ({
        ahead: 0, behind: 0, dirtyTracked: false, untracked: false, laneTip: 't', baseSha: 'b'
      })),
      destroy: vi.fn(async () => undefined)
    } as unknown as ConductorRuntime['lanes'],
    conductor: {
      publishLane: vi.fn(async () => ({ ok: true }) as never),
      syncLane: vi.fn(async () => ({ ok: true }) as never),
      lockHolder: vi.fn(() => null),
      reserveLock: vi.fn(() => true),
      releaseLock: vi.fn(),
      reconcile: vi.fn(async () => ({ needsAttention: false, operations: [] }))
    } as unknown as ConductorRuntime['conductor'],
    settings: {
      repo: '/repo', integrationBranch: 'crew/integration', integrationWorktree: '/int',
      lanesDir: '/lanes', maxLanes: 4, test: null
    },
    createSession: vi.fn(async () => ({ id: 'session-1' })),
    closeSession: vi.fn(),
    ...overrides
  }
}

function fakeDeps(overrides: Partial<ConductorBootstrapDeps> = {}): ConductorBootstrapDeps & {
  _configs: ConductorConfig[]
  _lanes: ConductorLane[]
} {
  const state = {
    configs: [] as ConductorConfig[],
    lanes: [] as ConductorLane[]
  }
  return {
    userDataDir: USER_DATA_DIR,
    getConductorConfigs: vi.fn(() => state.configs),
    saveConductorConfigs: vi.fn((list: ConductorConfig[]) => {
      state.configs = list
      return state.configs
    }),
    getConductorLanes: vi.fn(() => state.lanes),
    saveConductorLanes: vi.fn((list: ConductorLane[]) => {
      state.lanes = list
      return state.lanes
    }),
    createSession: vi.fn(async () => ({ id: 'session-x' })),
    closeSession: vi.fn(),
    broadcast: vi.fn(),
    get _configs() { return state.configs },
    get _lanes() { return state.lanes },
    ...overrides
  }
}


const EMPTY_SNAPSHOT = {
  enabled: false as const,
  publishing: null,
  lanes: [],
  facts: {},
  needsAttention: false,
  operations: [],
  reconciled: true,
  reconcileError: null
}

/** A backend factory whose backends are distinguishable per runtime, and
 *  which records the persistence hook each was built with — several tests
 *  below are about what the backend PERSISTS, not what it returns. */
function fakeBackendFactory(options: {
  compose?: (draft: unknown) => Promise<unknown>
} = {}) {
  const built: Array<{ runtime: ConductorRuntime | null; persistence?: ConductorPersistence }> = []
  const factory = vi.fn((runtime: ConductorRuntime | null, persistence?: ConductorPersistence): ConductorBackend => {
    built.push({ runtime, persistence })
    return {
      state: async () => ({
        ...EMPTY_SNAPSHOT,
        enabled: (runtime !== null) as false,
        lanes: []
      }),
      createLane: async () => { throw new Error('unused') },
      destroyLane: async () => undefined,
      publishLane: async () => ({ ok: true }) as never,
      syncLane: async () => ({ ok: true }) as never,
      reconcile: async () => ({ needsAttention: false, operations: [] }),
      acknowledgeOperation: async () => ({ ok: false, reason: 'unknown-operation' as const, message: 'unused' }),
      compose: (async (draft: unknown) =>
        options.compose ? options.compose(draft) : { ok: true, lanes: [] }) as ConductorBackend['compose']
    }
  })
  return { factory, built }
}

const DRAFT = {
  repo: '/Users/test/code/some-project',
  integrationBranch: 'crew/integration',
  rows: [],
  test: null
}

function existingConfig(workspaceId: string, overrides: Partial<ConductorConfig> = {}): ConductorConfig {
  return {
    workspaceId,
    repo: `/repo-${workspaceId}`,
    integrationBranch: 'crew/integration',
    // The paths a healthy store holds are exactly the derived ones — see the
    // F-5 test below for what happens when they are not.
    integrationWorktree: join(USER_DATA_DIR, 'conductor', workspaceId, 'integration'),
    lanesDir: join(USER_DATA_DIR, 'conductor', workspaceId, 'lanes'),
    maxLanes: 4,
    test: null,
    ...overrides
  }
}

describe('createConductorController: "All Sessions" (no workspace)', () => {
  it('is disabled for the null workspace', async () => {
    const controller = createConductorController(fakeDeps())
    await expect(controller.backendFor(null).state()).resolves.toEqual({
      enabled: false, publishing: null, lanes: [], facts: {}, needsAttention: false,
      operations: [], reconciled: true, reconcileError: null
    })
  })

  // Review finding 6: a compose that cannot run is a refusal the composer
  // can render, not a thrown error that crosses IPC as an unhandled
  // rejection the user never sees.
  it('refuses compose() for the null workspace with a structured error, never a throw', async () => {
    const deps = fakeDeps()
    const createConductorRuntime = vi.fn()
    const controller = createConductorController({ ...deps, createConductorRuntime })
    const result = await controller.compose(null, DRAFT)
    expect(result).toMatchObject({
      ok: false,
      errors: [{ field: 'workspace', message: expect.stringContaining('choose a workspace') }]
    })
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    expect(createConductorRuntime).not.toHaveBeenCalled()
  })
})

describe('createConductorController: workspace with no ConductorConfig yet', () => {
  it('reports disabled, not an error, before any compose has run', async () => {
    const controller = createConductorController(fakeDeps())
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: false })
  })

  it('derives a ConductorConfig from the compose draft, persists it, and binds a runtime to it', async () => {
    const deps = fakeDeps()
    const runtime = fakeRuntime()
    const createConductorRuntime = vi.fn(
      (_deps: { config: ConductorConfig; journalPath: string }) => runtime
    )
    const conductorPaths = vi.fn(() => ({
      integrationWorktree: join(USER_DATA_DIR, 'conductor', 'ws-1', 'integration'),
      lanesDir: join(USER_DATA_DIR, 'conductor', 'ws-1', 'lanes'),
      journal: join(USER_DATA_DIR, 'conductor', 'ws-1', 'journal.ndjson')
    }))
    let composedWith: unknown = null
    const { factory } = fakeBackendFactory({
      compose: async (draft) => {
        composedWith = draft
        return { ok: true, lanes: [] }
      }
    })

    const controller = createConductorController({
      ...deps,
      createConductorRuntime,
      conductorPaths,
      createShippedConductorBackend: factory
    })

    const result = await controller.compose('ws-1', DRAFT)
    expect(result).toEqual({ ok: true, lanes: [] })
    expect(composedWith).toEqual(DRAFT)

    expect(deps.saveConductorConfigs).toHaveBeenCalledTimes(1)
    expect(deps._configs).toEqual([{
      workspaceId: 'ws-1',
      repo: DRAFT.repo,
      integrationBranch: DRAFT.integrationBranch,
      integrationWorktree: join(USER_DATA_DIR, 'conductor', 'ws-1', 'integration'),
      lanesDir: join(USER_DATA_DIR, 'conductor', 'ws-1', 'lanes'),
      maxLanes: DEFAULT_MAX_LANES,
      test: null
    }])
    expect(createConductorRuntime).toHaveBeenCalledTimes(1)
    expect(createConductorRuntime.mock.calls[0][0]).toMatchObject({
      journalPath: join(USER_DATA_DIR, 'conductor', 'ws-1', 'journal.ndjson'),
      config: deps._configs[0]
    })

    // Now bound: state() must report enabled, not the disabled sentinel.
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: true })
  })

  // Review finding 4: a first compose that fails must leave NO trace. The
  // old code saved the derived config before composing, so a typo'd repo
  // permanently bound the workspace to a config that could never be
  // replaced — every later compose took the "already configured" path and
  // handed the draft to a runtime built on the bad repo.
  it('saves nothing, and leaves the workspace disabled, when the first compose fails with no survivors', async () => {
    const deps = fakeDeps()
    const { factory } = fakeBackendFactory({
      compose: async () => ({
        ok: false,
        failedRow: 0,
        message: 'not a git repository',
        errors: [],
        cleanupFailures: [],
        survivingLanes: []
      })
    })
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: factory
    })

    const result = await controller.compose('ws-1', DRAFT)
    expect(result).toMatchObject({ ok: false })
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    expect(deps._configs).toEqual([])
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: false })
  })

  it('saves nothing when the first compose throws', async () => {
    const deps = fakeDeps()
    const { factory } = fakeBackendFactory({
      compose: async () => { throw new Error('git exploded') }
    })
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: factory
    })
    await expect(controller.compose('ws-1', DRAFT)).rejects.toThrow('git exploded')
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: false })
  })

  // The one exception to "a failed compose leaves no trace": rollback could
  // not remove a lane, so it genuinely exists on disk. Dropping the config
  // would make that lane unreachable forever.
  it('does save the config when a failed compose left lanes behind', async () => {
    const deps = fakeDeps()
    const survivor: ConductorLane = {
      id: 'lane-1', roleId: 'builder', kind: 'author', agent: { presetId: 'shell', model: null },
      worktree: '/w/1', branch: 'crew/lane/builder', sessionId: null, status: 'working', dispatches: 0
    }
    const { factory } = fakeBackendFactory({
      compose: async () => ({
        ok: false,
        failedRow: 1,
        message: 'preset not installed',
        errors: [],
        cleanupFailures: [{ resource: 'lane', id: 'builder', message: 'permission denied' }],
        survivingLanes: [survivor]
      })
    })
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: factory
    })
    await controller.compose('ws-1', DRAFT)
    expect(deps._configs.map((c) => c.workspaceId)).toEqual(['ws-1'])
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: true })
  })
})

describe('createConductorController: an already-configured workspace', () => {
  it('binds a real runtime immediately (state() is enabled without any compose call)', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const runtime = fakeRuntime()
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    await expect(controller.backendFor('ws-1').state()).resolves.toMatchObject({ enabled: true })
  })

  it('does not persist a new config or reconstruct the runtime when compose() runs against an existing config', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    vi.clearAllMocks()
    const createConductorRuntime = vi.fn(() => fakeRuntime())
    let composedWith: unknown = null
    const { factory } = fakeBackendFactory({
      compose: async (draft) => {
        composedWith = draft
        return { ok: true, lanes: [] }
      }
    })
    const controller = createConductorController({
      ...deps,
      createConductorRuntime,
      createShippedConductorBackend: factory
    })
    await controller.backendFor('ws-1').state()
    expect(createConductorRuntime).toHaveBeenCalledTimes(1)

    const draft = { repo: '/wrong-repo', integrationBranch: 'crew/integration', rows: [], test: null }
    await controller.compose('ws-1', draft)
    expect(composedWith).toEqual(draft)
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    expect(createConductorRuntime).toHaveBeenCalledTimes(1)
  })
})

// Review finding 1: the controller has no active workspace of its own.
// Every call names the workspace it is about, so two windows showing two
// workspaces both get the truth, and a workspace switch that never reached
// main cannot make a call answer for the wrong workspace.
describe('createConductorController: per-call workspace resolution', () => {
  it('answers each call for the workspace that call named, with no binding step in between', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a'), existingConfig('ws-b')])
    const laneA: ConductorLane = {
      id: 'lane-a', roleId: 'builder', kind: 'author', agent: { presetId: 'shell', model: null },
      worktree: '/w/a', branch: 'crew/lane/builder', sessionId: null, status: 'working', dispatches: 0,
      workspaceId: 'ws-a'
    }
    deps.saveConductorLanes([laneA])

    const createConductorRuntime = vi.fn((d: { config: ConductorConfig }) =>
      fakeRuntime({ settings: { ...fakeRuntime().settings, repo: d.config.repo } })
    )
    const controller = createConductorController({ ...deps, createConductorRuntime })

    const stateA = await controller.backendFor('ws-a').state()
    const stateB = await controller.backendFor('ws-b').state()
    expect(stateA.lanes.map((l) => l.id)).toEqual(['lane-a'])
    expect(stateB.lanes).toEqual([])
    // Interleaved, in the other order: neither answer depends on which was
    // asked last, which is precisely what an active-workspace could not do.
    expect((await controller.backendFor('ws-b').state()).lanes).toEqual([])
    expect((await controller.backendFor('ws-a').state()).lanes.map((l) => l.id)).toEqual(['lane-a'])
  })

  it('builds one runtime per workspace and reuses it, rather than constructing a second live instance', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a'), existingConfig('ws-b')])
    const createConductorRuntime = vi.fn(() => fakeRuntime())
    const controller = createConductorController({ ...deps, createConductorRuntime })

    await controller.backendFor('ws-a').state()
    await controller.backendFor('ws-b').state()
    await controller.backendFor('ws-a').state()

    expect(createConductorRuntime).toHaveBeenCalledTimes(2)
  })

  it('preserves an in-flight lock: a genuinely still-busy workspace reports busy, not a fresh free lock', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a'), existingConfig('ws-b')])
    const runtimeA = fakeRuntime()
    ;(runtimeA.conductor.lockHolder as ReturnType<typeof vi.fn>).mockReturnValue('lane-1')
    const createConductorRuntime = vi.fn((d: { config: ConductorConfig }) =>
      d.config.workspaceId === 'ws-a' ? runtimeA : fakeRuntime()
    )
    const controller = createConductorController({ ...deps, createConductorRuntime })

    await controller.backendFor('ws-a').state()
    await controller.backendFor('ws-b').state()
    expect((await controller.backendFor('ws-a').state()).publishing).toBe('lane-1')
  })

  // Wave 4 finding F-5: after a restart the journal path was re-derived but
  // the worktree paths were taken from the store as saved. Conductor's
  // repair path runs `merge --abort`, a forced checkout and `clean -fd` in
  // the integration worktree, so a store carrying some other directory
  // (hand-edited, migrated from another machine, corrupted) would aim those
  // at it. Every Conductor path is derived, never trusted.
  it('re-derives the worktree paths from userDataDir rather than trusting the stored ones', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1', {
      integrationWorktree: '/Users/test/code/some-project',
      lanesDir: '/Users/test/code/some-project/.crew-lanes'
    })])
    const createConductorRuntime = vi.fn((_d: { config: ConductorConfig }) => fakeRuntime())
    const controller = createConductorController({ ...deps, createConductorRuntime })

    await controller.backendFor('ws-1').state()

    const bound = createConductorRuntime.mock.calls[0][0].config
    expect(bound.integrationWorktree).toBe(join(USER_DATA_DIR, 'conductor', 'ws-1', 'integration'))
    expect(bound.lanesDir).toBe(join(USER_DATA_DIR, 'conductor', 'ws-1', 'lanes'))
  })
})

// Review finding 3: the test recipe a successful compose put in force has to
// reach the STORED config, or every publish after a restart runs no tests
// while the UI still shows the recipe.
describe('createConductorController: test recipe persistence', () => {
  it('writes a recipe set on an already-configured workspace through to the stored config', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const { factory, built } = fakeBackendFactory()
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: factory
    })
    await controller.backendFor('ws-1').state()

    const recipe: TestRecipe = { command: 'npm', args: ['test'], cwd: '.', timeoutMs: 60_000 }
    built.at(-1)!.persistence!.saveTestRecipe!(recipe)

    expect(deps._configs).toEqual([{ ...existingConfig('ws-1'), test: recipe }])
  })

  it('carries a recipe set during a first compose into the config that compose saves', async () => {
    const deps = fakeDeps()
    const recipe: TestRecipe = { command: 'npm', args: ['test'], cwd: '.', timeoutMs: 60_000 }
    const built: ConductorPersistence[] = []
    const factory = vi.fn((runtime: ConductorRuntime | null, persistence?: ConductorPersistence): ConductorBackend => {
      if (persistence) built.push(persistence)
      return {
        state: async () => ({ ...EMPTY_SNAPSHOT, enabled: (runtime !== null) as false }),
        createLane: async () => { throw new Error('unused') },
        destroyLane: async () => undefined,
        publishLane: async () => ({ ok: true }) as never,
        syncLane: async () => ({ ok: true }) as never,
        reconcile: async () => ({ needsAttention: false, operations: [] }),
      acknowledgeOperation: async () => ({ ok: false, reason: 'unknown-operation' as const, message: 'unused' }),
        compose: (async () => {
          // What composeRun does on success: put the run's recipe in force.
          persistence?.saveTestRecipe?.(recipe)
          return { ok: true, lanes: [] }
        }) as ConductorBackend['compose']
      }
    })
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: factory
    })

    await controller.compose('ws-1', DRAFT)
    expect(deps._configs).toHaveLength(1)
    expect(deps._configs[0].test).toEqual(recipe)
  })
})

// Review finding 9: conducting a workspace whose sessions already answer to
// another conducted workspace would make the next saveSessions() silently
// drop one of those memberships.
describe('createConductorController: membership exclusivity at compose time', () => {
  it('refuses the first compose when a session already belongs to another conducted workspace', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a')])
    const createConductorRuntime = vi.fn(() => fakeRuntime())
    const controller = createConductorController({
      ...deps,
      createConductorRuntime,
      getWorkspaces: () => [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }],
      getSessions: () => [{ id: 's1', label: 'Session One', workspaceIds: ['ws-a', 'ws-b'] }]
    })

    const result = await controller.compose('ws-b', DRAFT)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok).toBe(false)
    const errors = (result as { ok: false; errors: Array<{ field: string; message: string }> }).errors
    expect(errors[0].field).toBe('workspace')
    expect(errors[0].message).toContain('Session One')
    expect(errors[0].message).toContain('Alpha')
    // Nothing derived, nothing saved, no runtime built for the refused one.
    expect(deps._configs.map((c) => c.workspaceId)).toEqual(['ws-a'])
  })

  it('allows the compose when no session answers to another conducted workspace', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a')])
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: fakeBackendFactory().factory,
      getWorkspaces: () => [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }],
      getSessions: () => [{ id: 's1', label: 'Session One', workspaceIds: ['ws-b'] }]
    })
    await expect(controller.compose('ws-b', DRAFT)).resolves.toMatchObject({ ok: true })
    expect(deps._configs.map((c) => c.workspaceId).sort()).toEqual(['ws-a', 'ws-b'])
  })

  // The membership graph check is strict (it throws on a duplicate id), and
  // this data comes from a store that really does produce duplicates. A
  // malformed graph must not block an otherwise fine compose.
  it('does not refuse a compose because the membership data was malformed', async () => {
    const deps = fakeDeps()
    const controller = createConductorController({
      ...deps,
      createConductorRuntime: vi.fn(() => fakeRuntime()),
      createShippedConductorBackend: fakeBackendFactory().factory,
      getWorkspaces: () => [{ id: 'ws-b', name: 'Beta' }, { id: 'ws-b', name: 'Beta again' }],
      getSessions: () => [{ id: 's1', label: 'Session One', workspaceIds: ['ws-b'] }]
    })
    await expect(controller.compose('ws-b', DRAFT)).resolves.toMatchObject({ ok: true })
  })
})

// Review finding 2: publish and sync are refused until a reconcile has
// completed for that workspace's backend, so something has to actually run
// one — eagerly, per backend, not only for whichever workspace a launch-time
// active-workspace happened to name.
describe('createConductorController: eager and launch reconcile', () => {
  it('reconciles a workspace as soon as its backend is built, and broadcasts the result for that workspace', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const broadcast = vi.fn()
    const runtime = fakeRuntime()
    const controller = createConductorController({
      ...deps, broadcast, createConductorRuntime: vi.fn(() => runtime)
    })

    await controller.backendFor('ws-1').state()
    await controller.reconcileOnLaunch()

    expect(runtime.conductor.reconcile).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    const [channel, payload] = broadcast.mock.calls[0]
    expect(channel).toBe('evt:conductorState')
    expect(payload).toMatchObject({ workspaceId: 'ws-1', state: { enabled: true } })
  })

  it('reconciles EVERY configured workspace at launch, not merely one', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-a'), existingConfig('ws-b'), existingConfig('ws-c')])
    const runtimes = new Map<string, ConductorRuntime>()
    const broadcast = vi.fn()
    const controller = createConductorController({
      ...deps,
      broadcast,
      createConductorRuntime: vi.fn((d: { config: ConductorConfig }) => {
        const rt = fakeRuntime()
        runtimes.set(d.config.workspaceId, rt)
        return rt
      })
    })

    await controller.reconcileOnLaunch()

    expect([...runtimes.keys()].sort()).toEqual(['ws-a', 'ws-b', 'ws-c'])
    for (const rt of runtimes.values()) {
      expect(rt.conductor.reconcile).toHaveBeenCalledTimes(1)
    }
    expect(broadcast.mock.calls.map((c) => (c[1] as { workspaceId: string }).workspaceId).sort())
      .toEqual(['ws-a', 'ws-b', 'ws-c'])
  })

  it('does nothing, and never throws, when no workspace has a config', async () => {
    const deps = fakeDeps()
    const broadcast = vi.fn()
    const controller = createConductorController({ ...deps, broadcast })
    await expect(controller.reconcileOnLaunch()).resolves.toBeUndefined()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('swallows a ConductorBusyError from reconcile() and never lets it escape', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const runtime = fakeRuntime()
    ;(runtime.conductor.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(new ConductorBusyError())
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    await expect(controller.reconcileOnLaunch()).resolves.toBeUndefined()
  })

  it('swallows a MalformedJournalError from reconcile() and never lets it escape', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const runtime = fakeRuntime()
    ;(runtime.conductor.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new MalformedJournalError('journal is corrupt')
    )
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    await expect(controller.reconcileOnLaunch()).resolves.toBeUndefined()
  })

  it('reconciles the other workspaces even when one of them cannot be bound at all', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('bad'), existingConfig('ws-ok')])
    const runtime = fakeRuntime()
    const controller = createConductorController({
      ...deps,
      conductorPaths: vi.fn((_dir: string, workspaceId: string) => {
        if (workspaceId === 'bad') throw new Error('invalid workspace id')
        return {
          integrationWorktree: '/int', lanesDir: '/lanes', journal: '/journal.ndjson'
        }
      }),
      createConductorRuntime: vi.fn(() => runtime)
    })
    await expect(controller.reconcileOnLaunch()).resolves.toBeUndefined()
    expect(runtime.conductor.reconcile).toHaveBeenCalledTimes(1)
  })
})

describe('index.ts wiring (AST assertions; index.ts imports electron and cannot run under environment: node)', () => {
  // Re-review finding I-2: these used to be regexes over source text with
  // full-line `//` comments stripped. That left a real bypass the reviewer
  // demonstrated — deleting the per-call backend lookup and leaving the old
  // code as a TRAILING comment on the same line kept every assertion green,
  // because only whole-comment-lines were removed. Parsing the real AST
  // removes the class of bypass entirely: a comment or a string literal
  // containing the same characters is not a CallExpression.
  const source = parseSource(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)))
  const main = source.getFullText()

  it('no longer constructs the shipped backend with a literal null runtime', () => {
    const disabled = findCallsTo(source, 'createShippedConductorBackend')
      .filter((call) => call.arguments[0]?.kind === ts.SyntaxKind.NullKeyword)
    expect(disabled).toHaveLength(0)
  })

  it('builds the conductor controller from the bootstrap module', () => {
    expect(hasNamedImport(source, 'conductor-bootstrap', 'createConductorController')).toBe(true)
    expect(findCallsTo(source, 'createConductorController')).toHaveLength(1)
  })

  // m-5.3: the controller needs the workspace and session readers to name
  // lanes and bind sessions. Asserting only that SOME call happens left
  // dropping either of them invisible here.
  it('gives the controller real readers for workspaces and sessions', () => {
    const construction = findCallsTo(source, 'createConductorController')[0]
    const literal = construction.arguments[0]
    expect(literal && ts.isObjectLiteralExpression(literal)).toBe(true)
    const properties = new Map(
      (literal as ts.ObjectLiteralExpression).properties
        .filter(ts.isPropertyAssignment)
        .map((prop) => [prop.name.getText(), prop.initializer])
    )
    for (const [name, reader] of [
      ['getWorkspaces', 'store.getWorkspaces'],
      ['getSessions', 'store.getSessions'],
      ['getConductorConfigs', 'store.getConductorConfigs'],
      ['getConductorLanes', 'store.getConductorLanes']
    ]) {
      const initializer = properties.get(name)
      expect(initializer, `createConductorController was given no ${name}`).toBeDefined()
      expect(
        findCallsTo(initializer!, reader).length,
        `${name} does not read from ${reader}()`
      ).toBeGreaterThan(0)
    }
  })

  it('runs the launch reconcile, for every workspace, after the window is created', () => {
    const whenReadyMatch = main.match(
      /app\.whenReady\(\)\s*\.\s*then\(\s*(?:async\s*)?\(\)\s*=>\s*\{[\s\S]*?\n\}\)/
    )
    expect(whenReadyMatch, 'could not locate app.whenReady().then(...) body in src/main/index.ts').not.toBeNull()
    const launchBody = whenReadyMatch![0]
    expect(launchBody.length, 'app.whenReady().then(...) body matched but was empty').toBeGreaterThan(0)

    const bodyWithoutComments = launchBody
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')

    const stepPattern = (name: string) => new RegExp(`^\\s*${name}\\s*;?\\s*$`, 'm')
    const steps = [
      ['registerIpc()', stepPattern('registerIpc\\(\\)')],
      ['rebuildAppMenu()', stepPattern('rebuildAppMenu\\(\\)')],
      ['createWindow()', stepPattern('createWindow\\(\\)')],
      // No argument: the launch reconcile covers every configured
      // workspace and broadcasts per workspace from inside the controller.
      ['reconcileOnLaunch()', stepPattern('void conductorController\\?\\.reconcileOnLaunch\\(\\)')]
    ] as const

    const indices = steps.map(([label, pattern]) => {
      const match = bodyWithoutComments.match(pattern)
      expect(match, `expected to find a "${label}" statement line in the launch sequence`).not.toBeNull()
      return bodyWithoutComments.indexOf(match![0])
    })

    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i],
        `expected "${steps[i][0]}" to run after "${steps[i - 1][0]}" in the launch sequence`
      ).toBeGreaterThan(indices[i - 1])
    }
  })

  // Review finding 1: conductor must not follow main's active workspace.
  it('never binds the conductor controller to main\'s active workspace', () => {
    const bindings = findAll(source, ts.isCallExpression).filter((call) => {
      const callee = flattenPropertyAccess(call.expression)
      return callee !== undefined && callee.endsWith('setActiveWorkspace') && callee.includes('conductor')
    })
    expect(bindings).toHaveLength(0)
  })

  // Re-review finding I-2 in full: the resolver must be a real function of
  // its own parameter. Pinning the exact argument NODES — rather than
  // matching characters — is what rejects the reviewer's bypass, in which
  // the live code closed over main's `activeWorkspace` and the correct call
  // survived only as a trailing comment.
  it('resolves the conductor backend per call, from the workspace id the call carries', () => {
    const registrations = findCallsTo(source, 'registerConductorIpc')
    expect(registrations).toHaveLength(1)
    const [channels, resolver] = registrations[0].arguments
    expect(channels?.getText()).toBe('ipcMain')
    expect(resolver && ts.isArrowFunction(resolver), 'the backend resolver is not an arrow function').toBe(true)

    const arrow = resolver as ts.ArrowFunction
    expect(arrow.parameters, 'the backend resolver takes no workspace id').toHaveLength(1)
    const parameter = arrow.parameters[0].name.getText()

    const lookups = findAll(arrow.body, ts.isCallExpression).filter((call) =>
      ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'backendFor'
    )
    expect(lookups, 'the resolver does not call backendFor').toHaveLength(1)
    // The id it looks up is the one THIS call carried — not a captured
    // variable that happens to be in scope.
    expect(
      lookups[0].arguments[0]?.getText(),
      'backendFor is not given the resolver\'s own parameter'
    ).toBe(parameter)
  })
})
