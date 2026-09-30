import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createConductorController,
  DEFAULT_MAX_LANES,
  type ConductorBootstrapDeps
} from '../src/main/conductor-bootstrap'
import type { ConductorConfig, ConductorLane } from '../src/shared/conductor'
import type { ConductorRuntime, ConductorBackend, ConductorLanePersistence } from '../src/main/conductor-ipc'
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
      isPublishing: vi.fn(() => false),
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
    get _configs() { return state.configs },
    get _lanes() { return state.lanes },
    ...overrides
  }
}

describe('createConductorController: no active workspace', () => {
  it('is disabled when no workspace is active', async () => {
    const controller = createConductorController(fakeDeps())
    controller.setActiveWorkspace(null)
    await expect(controller.backend.state()).resolves.toEqual({
      enabled: false, publishing: null, lanes: [], facts: {}, needsAttention: false
    })
  })

  it('rejects compose() cleanly when there is no active workspace to bind to', async () => {
    const controller = createConductorController(fakeDeps())
    controller.setActiveWorkspace(null)
    await expect(
      controller.backend.compose({ repo: '/repo', integrationBranch: 'crew/integration', rows: [], test: null })
    ).rejects.toThrow(/no active workspace/i)
  })
})

describe('createConductorController: workspace with no ConductorConfig yet', () => {
  it('reports disabled, not an error, before any compose has run', async () => {
    const controller = createConductorController(fakeDeps())
    controller.setActiveWorkspace('ws-1')
    await expect(controller.backend.state()).resolves.toMatchObject({ enabled: false })
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
    const createShippedConductorBackendFake = vi.fn((rt: ConductorRuntime | null, _persistence?: ConductorLanePersistence): ConductorBackend => ({
      state: async () => ({ enabled: rt !== null, publishing: null, lanes: [], facts: {}, needsAttention: false }),
      createLane: async () => { throw new Error('unused') },
      destroyLane: async () => undefined,
      publishLane: async () => ({ ok: true }) as never,
      syncLane: async () => ({ ok: true }) as never,
      reconcile: async () => ({ needsAttention: false, operations: [] }),
      compose: async (draft) => {
        composedWith = draft
        return { ok: true, lanes: [] } as never
      }
    }))

    const controller = createConductorController({
      ...deps,
      createConductorRuntime,
      conductorPaths,
      createShippedConductorBackend: createShippedConductorBackendFake
    })
    controller.setActiveWorkspace('ws-1')

    const draft = {
      repo: '/Users/test/code/some-project',
      integrationBranch: 'crew/integration',
      rows: [],
      test: null
    }
    const result = await controller.backend.compose(draft)
    expect(result).toEqual({ ok: true, lanes: [] })
    expect(composedWith).toEqual(draft)

    expect(deps.saveConductorConfigs).toHaveBeenCalledTimes(1)
    expect(deps._configs).toEqual([{
      workspaceId: 'ws-1',
      repo: draft.repo,
      integrationBranch: draft.integrationBranch,
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
    await expect(controller.backend.state()).resolves.toMatchObject({ enabled: true })
  })

  it('never writes a config, and never builds a runtime, on the no-active-workspace path', async () => {
    const deps = fakeDeps()
    const createConductorRuntime = vi.fn()
    const controller = createConductorController({ ...deps, createConductorRuntime })
    controller.setActiveWorkspace(null)
    await expect(
      controller.backend.compose({ repo: '/repo', integrationBranch: 'crew/integration', rows: [], test: null })
    ).rejects.toThrow()
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    expect(createConductorRuntime).not.toHaveBeenCalled()
  })
})

describe('createConductorController: an already-configured workspace', () => {
  function existingConfig(workspaceId: string): ConductorConfig {
    return {
      workspaceId,
      repo: '/repo',
      integrationBranch: 'crew/integration',
      integrationWorktree: '/int',
      lanesDir: '/lanes',
      maxLanes: 4,
      test: null
    }
  }

  it('binds a real runtime immediately (state() is enabled without any compose call)', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    const runtime = fakeRuntime()
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    controller.setActiveWorkspace('ws-1')
    await expect(controller.backend.state()).resolves.toMatchObject({ enabled: true })
  })

  it('does not persist a new config or reconstruct the runtime when compose() runs against an existing config', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([existingConfig('ws-1')])
    vi.clearAllMocks()
    const runtime = fakeRuntime()
    const createConductorRuntime = vi.fn(() => runtime)
    const composeSpy = vi.fn(async () => ({ ok: true, lanes: [] }) as never)
    const createShippedConductorBackendFake = vi.fn((rt: ConductorRuntime | null): ConductorBackend => ({
      state: async () => ({ enabled: rt !== null, publishing: null, lanes: [], facts: {}, needsAttention: false }),
      createLane: async () => { throw new Error('unused') },
      destroyLane: async () => undefined,
      publishLane: async () => ({ ok: true }) as never,
      syncLane: async () => ({ ok: true }) as never,
      reconcile: async () => ({ needsAttention: false, operations: [] }),
      compose: composeSpy
    }))
    const controller = createConductorController({
      ...deps,
      createConductorRuntime,
      createShippedConductorBackend: createShippedConductorBackendFake
    })
    controller.setActiveWorkspace('ws-1')
    expect(createConductorRuntime).toHaveBeenCalledTimes(1)

    const draft = { repo: '/wrong-repo', integrationBranch: 'crew/integration', rows: [], test: null }
    await controller.backend.compose(draft)
    expect(composeSpy).toHaveBeenCalledWith(draft)
    expect(deps.saveConductorConfigs).not.toHaveBeenCalled()
    expect(createConductorRuntime).toHaveBeenCalledTimes(1)
  })
})

describe('createConductorController: workspace switching', () => {
  function config(workspaceId: string): ConductorConfig {
    return {
      workspaceId,
      repo: `/repo-${workspaceId}`,
      integrationBranch: 'crew/integration',
      integrationWorktree: `/int-${workspaceId}`,
      lanesDir: `/lanes-${workspaceId}`,
      maxLanes: 4,
      test: null
    }
  }

  it('rebinds to the newly active workspace, and never shows the previous workspace\'s lanes', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([config('ws-a'), config('ws-b')])
    const laneA: ConductorLane = {
      id: 'lane-a', roleId: 'builder', kind: 'author', agent: { presetId: 'shell', model: null },
      worktree: '/w/a', branch: 'crew/lane/builder', sessionId: null, status: 'working', dispatches: 0,
      workspaceId: 'ws-a'
    }
    deps.saveConductorLanes([laneA])

    const runtimeA = fakeRuntime({ settings: { ...fakeRuntime().settings, repo: '/repo-ws-a' } })
    const runtimeB = fakeRuntime({ settings: { ...fakeRuntime().settings, repo: '/repo-ws-b' } })
    const createConductorRuntime = vi.fn((deps2: { config: ConductorConfig }) =>
      deps2.config.workspaceId === 'ws-a' ? runtimeA : runtimeB
    )
    const controller = createConductorController({ ...deps, createConductorRuntime })

    controller.setActiveWorkspace('ws-a')
    const stateA = await controller.backend.state()
    expect(stateA.enabled).toBe(true)
    expect(stateA.lanes.map((l) => l.id)).toEqual(['lane-a'])

    controller.setActiveWorkspace('ws-b')
    const stateB = await controller.backend.state()
    expect(stateB.enabled).toBe(true)
    expect(stateB.lanes).toEqual([])
  })

  it('reuses the same cached runtime/backend when switching back to a workspace already bound once, rather than constructing a second live instance', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([config('ws-a'), config('ws-b')])
    const createConductorRuntime = vi.fn(() => fakeRuntime())
    const controller = createConductorController({ ...deps, createConductorRuntime })

    controller.setActiveWorkspace('ws-a')
    await controller.backend.state()
    controller.setActiveWorkspace('ws-b')
    await controller.backend.state()
    controller.setActiveWorkspace('ws-a')
    await controller.backend.state()

    expect(createConductorRuntime).toHaveBeenCalledTimes(2) // once per distinct workspaceId, never twice for ws-a
  })

  it('preserves an in-flight lock across a switch away and back: a genuinely still-busy workspace reports busy, not a fresh free lock', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([config('ws-a'), config('ws-b')])
    const runtimeA = fakeRuntime()
    ;(runtimeA.conductor.lockHolder as ReturnType<typeof vi.fn>).mockReturnValue('lane-1')
    const createConductorRuntime = vi.fn((deps2: { config: ConductorConfig }) =>
      deps2.config.workspaceId === 'ws-a' ? runtimeA : fakeRuntime()
    )
    const controller = createConductorController({ ...deps, createConductorRuntime })

    controller.setActiveWorkspace('ws-a')
    await controller.backend.state()
    controller.setActiveWorkspace('ws-b')
    await controller.backend.state()
    controller.setActiveWorkspace('ws-a')
    const state = await controller.backend.state()
    expect(state.publishing).toBe('lane-1')
  })
})

describe('createConductorController: launch reconcile', () => {
  it('does nothing, and never throws, when no runtime is bound', async () => {
    const controller = createConductorController(fakeDeps())
    controller.setActiveWorkspace(null)
    const broadcast = vi.fn()
    await expect(controller.reconcileOnLaunch(broadcast)).resolves.toBeUndefined()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('runs reconcile() once and broadcasts the resulting state when a runtime is bound', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([{
      workspaceId: 'ws-1', repo: '/repo', integrationBranch: 'crew/integration',
      integrationWorktree: '/int', lanesDir: '/lanes', maxLanes: 4, test: null
    }])
    const runtime = fakeRuntime()
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    controller.setActiveWorkspace('ws-1')
    const broadcast = vi.fn()
    await controller.reconcileOnLaunch(broadcast)
    expect(runtime.conductor.reconcile).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledTimes(1)
    const [channel, payload] = broadcast.mock.calls[0]
    expect(channel).toBe('evt:conductorState')
    expect(payload).toMatchObject({ enabled: true })
  })

  it('swallows a ConductorBusyError from reconcile() and never lets it escape', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([{
      workspaceId: 'ws-1', repo: '/repo', integrationBranch: 'crew/integration',
      integrationWorktree: '/int', lanesDir: '/lanes', maxLanes: 4, test: null
    }])
    const runtime = fakeRuntime()
    ;(runtime.conductor.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(new ConductorBusyError())
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    controller.setActiveWorkspace('ws-1')
    await expect(controller.reconcileOnLaunch(vi.fn())).resolves.toBeUndefined()
  })

  it('swallows a MalformedJournalError from reconcile() and never lets it escape', async () => {
    const deps = fakeDeps()
    deps.saveConductorConfigs([{
      workspaceId: 'ws-1', repo: '/repo', integrationBranch: 'crew/integration',
      integrationWorktree: '/int', lanesDir: '/lanes', maxLanes: 4, test: null
    }])
    const runtime = fakeRuntime()
    ;(runtime.conductor.reconcile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new MalformedJournalError('journal is corrupt')
    )
    const controller = createConductorController({ ...deps, createConductorRuntime: vi.fn(() => runtime) })
    controller.setActiveWorkspace('ws-1')
    await expect(controller.reconcileOnLaunch(vi.fn())).resolves.toBeUndefined()
  })
})

describe('index.ts wiring (source-text assertions; index.ts imports electron and cannot run under environment: node)', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

  it('no longer constructs the shipped backend with a literal null runtime', () => {
    expect(main).not.toMatch(/createShippedConductorBackend\(\s*null\s*\)/)
  })

  it('builds the conductor controller from the bootstrap module', () => {
    expect(main).toContain('createConductorController')
    expect(main).toContain("from './conductor-bootstrap'")
  })

  it('runs the launch reconcile after the window is created', () => {
    // Anchor to the actual launch sequence inside app.whenReady().then(...),
    // not the first textual match of createWindow() anywhere in the file —
    // createWindow() also appears earlier (e.g. openWindow()) and later
    // (app.on('activate', ...)), so a bare indexOf() pair would still pass
    // even if reconcileOnLaunch were hoisted above the launch-time
    // createWindow() call.
    //
    // Tolerant of `async`, extra whitespace/line breaks before the `{`; if the
    // body can't be found at all, fail loudly rather than silently matching
    // nothing (a vacuously-true assertion is worse than the brittle regex it
    // replaced).
    const whenReadyMatch = main.match(
      /app\.whenReady\(\)\s*\.\s*then\(\s*(?:async\s*)?\(\)\s*=>\s*\{[\s\S]*?\n\}\)/
    )
    expect(whenReadyMatch, 'could not locate app.whenReady().then(...) body in src/main/index.ts').not.toBeNull()
    const launchBody = whenReadyMatch![0]
    expect(launchBody.length, 'app.whenReady().then(...) body matched but was empty').toBeGreaterThan(0)

    // Strip comments so a mention inside a `//` line comment or a `/* */`
    // block (e.g. a bypassed reordering with `// createWindow()` left behind
    // as a decoy) can never satisfy the order assertion below.
    const withoutBlockComments = launchBody.replace(/\/\*[\s\S]*?\*\//g, '')
    const withoutComments = withoutBlockComments.replace(/\/\/.*$/gm, '')

    // Each step must appear as its own executable statement line, not merely
    // as a substring anywhere in the body (which would also match a comment,
    // a string literal, or part of a longer identifier).
    const stepPattern = (name: string) => new RegExp(`^\\s*${name}\\s*;?\\s*$`, 'm')
    const steps = [
      ['registerIpc()', stepPattern('registerIpc\\(\\)')],
      ['rebuildAppMenu()', stepPattern('rebuildAppMenu\\(\\)')],
      ['createWindow()', stepPattern('createWindow\\(\\)')],
      ['reconcileOnLaunch(broadcast)', stepPattern('void conductorController\\?\\.reconcileOnLaunch\\(broadcast\\)')]
    ] as const

    const indices = steps.map(([label, pattern]) => {
      const match = withoutComments.match(pattern)
      expect(match, `expected to find a "${label}" statement line in the launch sequence`).not.toBeNull()
      return withoutComments.indexOf(match![0])
    })

    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i],
        `expected "${steps[i][0]}" to run after "${steps[i - 1][0]}" in the launch sequence`
      ).toBeGreaterThan(indices[i - 1])
    }
  })

  it('rebinds the conductor controller when the active workspace changes', () => {
    expect(main).toContain('setActiveWorkspace')
    expect(main).toMatch(/conductorController\??\.setActiveWorkspace/)
  })
})
