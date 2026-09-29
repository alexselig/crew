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
        IPC.CONDUCTOR_RECONCILE
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
      'CONDUCTOR_PUBLISH', 'CONDUCTOR_SYNC', 'CONDUCTOR_RECONCILE',
      'EVT_CONDUCTOR_STATE'
    ]) {
      expect(preload).toContain(`IPC.${key}`)
    }
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
    expect(broadcast).not.toHaveBeenCalled()
  })
})
