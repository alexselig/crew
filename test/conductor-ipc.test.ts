import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../src/shared/types'
import {
  registerConductorIpc,
  createShippedConductorBackend,
  type ConductorBackend
} from '../src/main/conductor-ipc'
import { ConductorBusyError } from '../src/main/conductor'
import type { ConductorLane } from '../src/shared/conductor'

type Handler = Parameters<IpcMain['handle']>[1]

function lane(overrides: Partial<ConductorLane> = {}): ConductorLane {
  return {
    id: 'lane-1',
    roleId: 'builder',
    kind: 'author',
    branch: 'crew/lane/builder',
    worktree: '/tmp/lanes/builder',
    sessionId: null,
    agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' },
    status: 'working',
    blockedReason: undefined,
    dispatches: 0,
    ...overrides
  }
}

function harness(backend: Partial<ConductorBackend> = {}) {
  const handlers = new Map<string, Handler>()
  const broadcast = vi.fn()
  const full: ConductorBackend = {
    state: vi.fn(async () => ({
      enabled: true,
      publishing: null,
      lanes: [lane()],
      facts: {},
      needsAttention: false
    })),
    createLane: vi.fn(async () => lane({ id: 'lane-2' })),
    destroyLane: vi.fn(async () => undefined),
    publishLane: vi.fn(async () => ({ ok: true as const, commit: 'abc', touchedPaths: [], warnings: [] })),
    syncLane: vi.fn(async () => ({ ok: true as const, resultSha: 'def', fastForward: true })),
    reconcile: vi.fn(async () => ({ needsAttention: false, operations: [] })),
    compose: vi.fn(async () => ({ ok: true as const, lanes: [lane({ id: 'lane-3' })] })),
    ...backend
  }
  registerConductorIpc({ handle: (channel, handler) => void handlers.set(channel, handler) }, full, broadcast)
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return Promise.resolve().then(() => handler({} as IpcMainInvokeEvent, ...args))
  }
  return { broadcast, handlers, invoke, backend: full }
}

describe('conductor IPC contract', () => {
  it('registers every conductor channel', () => {
    const { handlers } = harness()
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.CONDUCTOR_STATE,
        IPC.CONDUCTOR_LANE_CREATE,
        IPC.CONDUCTOR_LANE_DESTROY,
        IPC.CONDUCTOR_PUBLISH,
        IPC.CONDUCTOR_SYNC,
        IPC.CONDUCTOR_RECONCILE,
        IPC.CONDUCTOR_COMPOSE
      ].sort()
    )
  })

  it('returns state without broadcasting, because reads are not changes', async () => {
    const { invoke, broadcast } = harness()
    const state = await invoke(IPC.CONDUCTOR_STATE)
    expect(state).toMatchObject({ enabled: true, publishing: null })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('broadcasts fresh state after a successful publication', async () => {
    const { invoke, broadcast } = harness()
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: true, commit: 'abc' })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
  })

  // A rejected publication still changes what the user should see: the lane
  // is now blocked. Broadcasting only on success would strand that in the UI.
  it('broadcasts fresh state after a rejected publication too', async () => {
    const { invoke, broadcast } = harness({
      publishLane: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const, conflictPaths: ['a.txt'], message: 'conflict' }))
    })
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('does not fail a handler whose mutation already succeeded, even if broadcasting fresh state throws', async () => {
    // Finding 5: publishLane below has ALREADY committed (backend.publishLane
    // resolves ok:true) before publishState() runs. If computing the
    // broadcast snapshot throws (e.g. a lane's worktree is gone), the
    // renderer must still see the successful outcome the mutation actually
    // produced — never a rejected promise for work that succeeded.
    const { invoke, broadcast } = harness({
      state: vi.fn(async () => { throw new Error('state computation exploded') })
    })
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: true, commit: 'abc' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('does not broadcast when a handler throws', async () => {
    const { invoke, broadcast } = harness({
      createLane: vi.fn(async () => { throw new Error('lane limit reached') })
    })
    await expect(invoke(IPC.CONDUCTOR_LANE_CREATE, { roleId: 'builder', agent: { presetId: 'shell', model: null } }))
      .rejects.toThrow('lane limit reached')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('passes lane creation arguments through unchanged', async () => {
    const { invoke, backend } = harness()
    const request = { roleId: 'reviewer', agent: { presetId: 'copilot-cli', model: 'claude-opus-5' } }
    await invoke(IPC.CONDUCTOR_LANE_CREATE, request)
    expect(backend.createLane).toHaveBeenCalledWith(request)
  })

  // Only reconcile() throws ConductorBusyError (see conductor.ts) —
  // publishLane and syncLane instead return a structured { ok: false,
  // reason: 'busy' } outcome, so those two are already covered by the
  // "rejected publication" style tests above and don't need this shape.
  it('rejects with ConductorBusyError\'s message when reconcile is already in flight, and broadcasts nothing', async () => {
    const { invoke, broadcast } = harness({
      reconcile: vi.fn(async () => { throw new ConductorBusyError() })
    })
    await expect(invoke(IPC.CONDUCTOR_RECONCILE)).rejects.toThrow(
      'conductor is busy: a publication, sync, or reconcile is already in flight'
    )
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('exposes every conductor channel through the preload bridge', () => {
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
    for (const key of [
      'CONDUCTOR_STATE', 'CONDUCTOR_LANE_CREATE', 'CONDUCTOR_LANE_DESTROY',
      'CONDUCTOR_PUBLISH', 'CONDUCTOR_SYNC', 'CONDUCTOR_RECONCILE', 'CONDUCTOR_COMPOSE',
      'EVT_CONDUCTOR_STATE'
    ]) {
      expect(preload).toContain(`IPC.${key}`)
    }
  })

  it('registers the compose channel and broadcasts fresh state after a successful compose', async () => {
    const { invoke, broadcast, backend } = harness()
    const draft = {
      repo: '/repo',
      integrationBranch: 'crew/integration',
      rows: [{ roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } }]
    }
    const result = await invoke(IPC.CONDUCTOR_COMPOSE, draft)
    expect(result).toMatchObject({ ok: true })
    expect(backend.compose).toHaveBeenCalledWith(draft)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
  })

  // Unlike publish/sync, a failed compose never partially changes anything —
  // every lane it created is rolled back — so there is nothing new to show.
  it('does not broadcast when compose reports a failure', async () => {
    const { invoke, broadcast } = harness({
      compose: vi.fn(async () => ({ ok: false as const, errors: [{ field: 'rows', message: 'add at least one lane' }] }))
    })
    const result = await invoke(IPC.CONDUCTOR_COMPOSE, { repo: '/repo', integrationBranch: 'crew/integration', rows: [] })
    expect(result).toMatchObject({ ok: false })
    expect(broadcast).not.toHaveBeenCalled()
  })

  // When rollback itself fails to fully undo what it created, the premise
  // behind the test above ("nothing changed") no longer holds: a lane or
  // session survived. That must broadcast, exactly like every other mutating
  // handler, or the survivor is invisible to the renderer.
  it('broadcasts fresh state when a failed compose could not fully clean up after itself', async () => {
    const { invoke, broadcast } = harness({
      compose: vi.fn(async () => ({
        ok: false as const,
        failedRow: 1,
        message: 'preset not installed',
        errors: [],
        cleanupFailures: [{ resource: 'lane' as const, id: 'builder', message: 'permission denied' }]
      }))
    })
    const draft = {
      repo: '/repo',
      integrationBranch: 'crew/integration',
      rows: [{ roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } }]
    }
    const result = await invoke(IPC.CONDUCTOR_COMPOSE, draft)
    expect(result).toMatchObject({ ok: false, failedRow: 1 })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
  })

  it('registers the conductor IPC module from the main entrypoint', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('registerConductorIpc')
  })
})

describe('the shipped conductor backend, with no settings composer wired yet', () => {
  // src/main/index.ts constructs createShippedConductorBackend(null) because
  // no composer exists yet to produce real ConductorSettings — this is the
  // exact backend shape shipped to users today, so its disabled path must be
  // exercised even though nothing wires a real runtime until a later task.
  it('reports itself disabled, with no lanes and nothing needing attention', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(backend.state()).resolves.toEqual({
      enabled: false,
      publishing: null,
      lanes: [],
      facts: {},
      needsAttention: false
    })
  })

  it('refuses lane creation cleanly rather than guessing at settings', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(
      backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    ).rejects.toThrow('conductor is not configured for this workspace yet')
  })

  it('refuses lane destruction cleanly', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(backend.destroyLane('lane-1')).rejects.toThrow(
      'conductor is not configured for this workspace yet'
    )
  })

  it('refuses publishing cleanly', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(backend.publishLane('lane-1')).rejects.toThrow(
      'conductor is not configured for this workspace yet'
    )
  })

  it('refuses syncing cleanly', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(backend.syncLane('lane-1')).rejects.toThrow(
      'conductor is not configured for this workspace yet'
    )
  })

  it('refuses reconciliation cleanly', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(backend.reconcile()).rejects.toThrow(
      'conductor is not configured for this workspace yet'
    )
  })

  it('refuses composing a run cleanly', async () => {
    const backend = createShippedConductorBackend(null)
    await expect(
      backend.compose({ repo: '/repo', integrationBranch: 'crew/integration', rows: [], test: null })
    ).rejects.toThrow('conductor is not configured for this workspace yet')
  })

  it('wired through registerConductorIpc, refuses every mutating channel over IPC too', async () => {
    const handlers = new Map<string, Handler>()
    const broadcast = vi.fn()
    registerConductorIpc(
      { handle: (channel, handler) => void handlers.set(channel, handler) },
      createShippedConductorBackend(null),
      broadcast
    )
    const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`missing handler: ${channel}`)
      return Promise.resolve().then(() => handler({} as IpcMainInvokeEvent, ...args))
    }

    await expect(invoke(IPC.CONDUCTOR_STATE)).resolves.toMatchObject({ enabled: false })
    await expect(invoke(IPC.CONDUCTOR_LANE_CREATE, { roleId: 'builder', agent: { presetId: 'shell', model: null } }))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_LANE_DESTROY, 'lane-1'))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1'))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_SYNC, 'lane-1'))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_RECONCILE))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_COMPOSE, { repo: '/repo', integrationBranch: 'crew/integration', rows: [] }))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    expect(broadcast).not.toHaveBeenCalled()
  })

  // Finding 5: `destroy()` in the real LaneManager can remove a lane's
  // worktree successfully and then have `git branch -d` fail — the lane
  // stays in lanesById with no worktree on disk. state()'s per-lane facts()
  // call for that lane throws (no such worktree). Every OTHER wired lane
  // must still get its facts, and state() itself must resolve rather than
  // reject.
  it('degrades a lane whose facts() call throws instead of failing state() for every lane', async () => {
    const goodLane: ConductorLane = lane({ id: 'lane-good' })
    const badLane: ConductorLane = lane({ id: 'lane-bad', worktree: '/gone' })
    const goodFacts = {
      ahead: 1, behind: 0, dirtyTracked: false, untracked: false, laneTip: 'tip', baseSha: 'base'
    }
    const fakeLanes: import('../src/main/lanes').LaneManager = {
      ensureIntegrationWorktree: vi.fn(async () => undefined),
      create: vi.fn(async (roleId: string) => (roleId === 'bad' ? badLane : goodLane)),
      facts: vi.fn(async (l: ConductorLane) => {
        if (l.id === 'lane-bad') throw new Error('worktree does not exist')
        return goodFacts
      }),
      mergeInIntegration: vi.fn(),
      syncLane: vi.fn(),
      publish: vi.fn(),
      destroy: vi.fn()
    } as unknown as import('../src/main/lanes').LaneManager
    const runtime = {
      lanes: fakeLanes,
      conductor: {
        publishLane: vi.fn(), syncLane: vi.fn(), isPublishing: vi.fn(), reconcile: vi.fn()
      } as unknown as import('../src/main/conductor').Conductor,
      settings: {} as import('../src/shared/conductor').ConductorSettings,
      createSession: vi.fn(),
      closeSession: vi.fn()
    }
    const backend = createShippedConductorBackend(runtime)
    await backend.createLane({ roleId: 'good', agent: { presetId: 'shell', model: null } })
    await backend.createLane({ roleId: 'bad', agent: { presetId: 'shell', model: null } })

    const state = await backend.state()
    expect(state.enabled).toBe(true)
    expect(state.lanes).toHaveLength(2)
    expect(state.facts['lane-good']).toEqual(goodFacts)
    expect(state.facts['lane-bad']).toBeUndefined()
  })

  // Task 4's seam: composeRun calls deps.setTestRecipe once a run fully
  // succeeds, and createShippedConductorBackend's compose() must actually
  // wire that seam to the live runtime it was handed — not merely accept
  // the field and drop it, which would be the same silent bug review
  // finding 4 raised, just moved one field over.
  it('writes a successfully composed test recipe into the live runtime settings', async () => {
    const createdLane = lane({ id: 'lane-x', roleId: 'builder' })
    const fakeLanes = {
      ensureIntegrationWorktree: vi.fn(async () => undefined),
      create: vi.fn(async () => createdLane),
      facts: vi.fn(async () => ({
        ahead: 0, behind: 0, dirtyTracked: false, untracked: false, laneTip: 't', baseSha: 'b'
      })),
      mergeInIntegration: vi.fn(),
      syncLane: vi.fn(),
      publish: vi.fn(),
      destroy: vi.fn()
    } as unknown as import('../src/main/lanes').LaneManager
    const settings: import('../src/shared/conductor').ConductorSettings = {
      repo: '/repo',
      integrationBranch: 'crew/integration',
      integrationWorktree: '/repo-integration',
      lanesDir: '/lanes',
      maxLanes: 3,
      test: null
    }
    const runtime = {
      lanes: fakeLanes,
      conductor: {
        publishLane: vi.fn(), syncLane: vi.fn(), isPublishing: vi.fn(), reconcile: vi.fn()
      } as unknown as import('../src/main/conductor').Conductor,
      settings,
      createSession: vi.fn(async () => ({ id: 'sess' })),
      closeSession: vi.fn()
    }
    const backend = createShippedConductorBackend(runtime)
    const recipe = { command: 'npm', args: ['test'], cwd: '.', timeoutMs: 5000 }

    const result = await backend.compose({
      repo: '/repo',
      integrationBranch: 'crew/integration',
      rows: [{ roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } }],
      test: recipe
    })

    expect(result.ok).toBe(true)
    expect(runtime.settings.test).toEqual(recipe)
  })

  it('rejects a compose whose draft repo does not match the live runtime, over IPC too', async () => {
    const runtime = {
      lanes: {} as import('../src/main/lanes').LaneManager,
      conductor: {} as import('../src/main/conductor').Conductor,
      settings: {
        repo: '/repo', integrationBranch: 'crew/integration',
        integrationWorktree: '/repo-integration', lanesDir: '/lanes', maxLanes: 3, test: null
      },
      createSession: vi.fn(),
      closeSession: vi.fn()
    }
    const backend = createShippedConductorBackend(runtime)
    const result = await backend.compose({
      repo: '/somewhere-else',
      integrationBranch: 'crew/integration',
      rows: [{ roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } }],
      test: null
    })
    expect(result).toMatchObject({ ok: false, errors: [{ field: 'repo' }] })
  })
})
