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

/** A minimal fake LaneManager for Task 5's backend-hardening tests: only the
 *  methods createLane/destroyLane actually call are given real behaviour by
 *  default; everything else is a vi.fn() the test can override. */
function fakeLaneManager(overrides: Partial<import('../src/main/lanes').LaneManager> = {}) {
  return {
    ensureIntegrationWorktree: vi.fn(async () => undefined),
    create: vi.fn(async (name: string, agent: unknown) => lane({ id: `lane-${name}`, roleId: name, agent: agent as ConductorLane['agent'] })),
    facts: vi.fn(async () => ({
      ahead: 0, behind: 0, dirtyTracked: false, untracked: false, laneTip: 't', baseSha: 'b'
    })),
    mergeInIntegration: vi.fn(),
    syncLane: vi.fn(),
    publish: vi.fn(),
    destroy: vi.fn(async () => undefined),
    ...overrides
  } as unknown as import('../src/main/lanes').LaneManager
}

/** A minimal fake Conductor for Task 5's backend-hardening tests. Carries a
 *  real single-flight lock (not just vi.fn()s) so lockHolder()/reserveLock()/
 *  releaseLock() behave exactly like the real implementation in conductor.ts
 *  — several of these tests are load-bearing on that interaction, not merely
 *  on whether the methods were called. */
function fakeConductor(overrides: Partial<import('../src/main/conductor').Conductor> = {}) {
  let locked: string | null = null
  return {
    publishLane: vi.fn(async () => ({ ok: true as const, commit: 'abc', touchedPaths: [], warnings: [] })),
    syncLane: vi.fn(async () => ({ ok: true as const, resultSha: 'def', fastForward: true })),
    isPublishing: vi.fn(() => locked !== null),
    lockHolder: vi.fn(() => locked),
    reserveLock: vi.fn((holder: string) => {
      if (locked !== null) return false
      locked = holder
      return true
    }),
    releaseLock: vi.fn((holder: string) => { if (locked === holder) locked = null }),
    reconcile: vi.fn(async () => ({ needsAttention: false, operations: [] })),
    ...overrides
  } as unknown as import('../src/main/conductor').Conductor
}

function fakeRuntime(overrides: {
  lanes?: Partial<import('../src/main/lanes').LaneManager>
  conductor?: Partial<import('../src/main/conductor').Conductor>
  settings?: Partial<import('../src/shared/conductor').ConductorSettings>
  createSession?: import('../src/main/conductor-compose').ComposeDeps['createSession']
  closeSession?: import('../src/main/conductor-compose').ComposeDeps['closeSession']
} = {}) {
  return {
    lanes: fakeLaneManager(overrides.lanes),
    conductor: fakeConductor(overrides.conductor),
    settings: {
      repo: '/repo',
      integrationBranch: 'crew/integration',
      integrationWorktree: '/repo-integration',
      lanesDir: '/lanes',
      maxLanes: 3,
      test: null,
      ...overrides.settings
    },
    createSession: overrides.createSession ?? vi.fn(async () => ({ id: 'sess' })),
    closeSession: overrides.closeSession ?? vi.fn()
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
    // Finding 1: publish/sync now broadcast twice — once as soon as the lock
    // is observably taken (before the outcome is known), once more once it
    // settles — so the panel can see `publishing: true` for the operation's
    // whole duration, not merely its eventual result.
    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(broadcast.mock.calls[0][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
    expect(broadcast.mock.calls[1][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
  })

  // A rejected publication still changes what the user should see: the lane
  // is now blocked. Broadcasting only on success would strand that in the UI.
  it('broadcasts fresh state after a rejected publication too', async () => {
    const { invoke, broadcast } = harness({
      publishLane: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const, conflictPaths: ['a.txt'], message: 'conflict' }))
    })
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(broadcast).toHaveBeenCalledTimes(2)
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
        cleanupFailures: [{ resource: 'lane' as const, id: 'builder', message: 'permission denied' }],
        survivingLanes: []
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
    expect(broadcast).not.toHaveBeenCalled()
    // Finding 1: CONDUCTOR_PUBLISH/SYNC broadcast unconditionally, once
    // before the outcome and once after (see their own comment in
    // conductor-ipc.ts) — even when disabled, since a disabled backend's
    // state() never throws and broadcasting its (unchanged, still disabled)
    // truth is harmless. CREATE/DESTROY/RECONCILE/COMPOSE above and below
    // are unaffected: their refusal is a synchronous throw with nothing to
    // observe changing, so they still broadcast nothing at all.
    await expect(invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1'))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    await expect(invoke(IPC.CONDUCTOR_SYNC, 'lane-1'))
      .rejects.toThrow('conductor is not configured for this workspace yet')
    expect(broadcast).toHaveBeenCalledTimes(4)
    for (const call of broadcast.mock.calls) {
      expect(call[1]).toMatchObject({ enabled: false })
    }
    broadcast.mockClear()
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
        publishLane: vi.fn(), syncLane: vi.fn(), isPublishing: vi.fn(), reconcile: vi.fn(),
        lockHolder: vi.fn(() => null), reserveLock: vi.fn(() => true), releaseLock: vi.fn()
      } as unknown as import('../src/main/conductor').Conductor,
      settings: {
        repo: '/repo', integrationBranch: 'crew/integration',
        integrationWorktree: '/repo-integration', lanesDir: '/lanes', maxLanes: 3, test: null
      } as import('../src/shared/conductor').ConductorSettings,
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

  // Task 5, finding 3 (fix round 1): a lane rollback could not remove used
  // to be announced (cleanupFailures) but never registered anywhere — not
  // in lanesById, not in state(), not persisted. Load-bearing: the surviving
  // lane must appear in backend.state() AND in whatever persistence.
  // saveLanes() last received, tagged with this workspace's id like any
  // other persisted lane.
  it('registers and persists a lane compose rollback could not remove, so it appears in state() and in persistence', async () => {
    const builderLane = lane({ id: 'lane-builder', roleId: 'builder', sessionId: 'sess-builder' })
    const scoutLane = lane({ id: 'lane-scout', roleId: 'scout', sessionId: null })
    const create = vi.fn(async (roleName: string) =>
      roleName === 'builder' ? builderLane : scoutLane
    )
    // builder's session closes fine, then destroy() is asked to remove it
    // and fails — exactly conductor-compose.test.ts's "reports a lane
    // rollback could not remove" scenario, at the IPC/backend layer.
    const destroy = vi.fn(async (l: ConductorLane) => {
      if (l.roleId === 'builder') throw new Error('git worktree remove failed')
    })
    const createSession = vi.fn()
      .mockResolvedValueOnce({ id: 'sess-builder' })
      .mockRejectedValueOnce(new Error('preset not installed'))
    let stored: ConductorLane[] = []
    const saveLanes = vi.fn((list: ConductorLane[]) => { stored = list })
    const runtime = fakeRuntime({
      lanes: { create, destroy },
      createSession
    })
    const backend = createShippedConductorBackend(runtime as never, {
      workspaceId: 'workspace-mine', loadLanes: () => [], saveLanes
    })

    const result = await backend.compose({
      repo: runtime.settings.repo,
      integrationBranch: runtime.settings.integrationBranch,
      rows: [
        { roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } },
        { roleName: 'scout', kind: 'author' as const, agent: { presetId: 'shell', model: null } }
      ],
      test: null
    })

    expect(result.ok).toBe(false)
    if (result.ok || !('survivingLanes' in result)) throw new Error('expected a row failure')
    expect(result.survivingLanes).toContainEqual(expect.objectContaining({ roleId: 'builder' }))

    const state = await backend.state()
    expect(state.lanes.map((l) => l.roleId)).toContain('builder')

    expect(saveLanes).toHaveBeenCalled()
    expect(stored.find((l) => l.roleId === 'builder')).toMatchObject({ workspaceId: 'workspace-mine' })
  })
})

describe('Task 5: the backend as the lock/persistence boundary', () => {
  // Finding 1: the panel never saw `publishing: true` because the flag was
  // only broadcast after the operation ended. registerConductorIpc's
  // publish/sync handlers must now broadcast once the lock is observably
  // taken (not just once it is released). This is provable at the
  // conductor-ipc.ts level without a real Conductor: initiate the invoke,
  // let only the pre-outcome microtask run, and check a broadcast already
  // reported the lock taken — all BEFORE the publishLane promise resolves.
  it('broadcasts state showing the lock taken before the publish outcome resolves, item 1', async () => {
    let released!: () => void
    const pending = new Promise<{ ok: true; commit: string; touchedPaths: string[]; warnings: string[] }>((resolve) => {
      released = () => { lockTaken = false; resolve({ ok: true, commit: 'abc', touchedPaths: [], warnings: [] }) }
    })
    let lockTaken = false
    const { invoke, broadcast } = harness({
      state: vi.fn(async () => ({
        enabled: true, publishing: lockTaken ? 'lane-1' : null, lanes: [lane()], facts: {}, needsAttention: false
      })),
      publishLane: vi.fn(() => {
        lockTaken = true
        return pending
      })
    })

    const invokePromise = invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    // Flush microtasks up to (but not past) the pending publishLane promise.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(broadcast).toHaveBeenCalled()
    expect(broadcast.mock.calls[0][1]).toMatchObject({ publishing: 'lane-1' })

    released()
    const outcome = await invokePromise
    expect(outcome).toMatchObject({ ok: true, commit: 'abc' })
    expect(broadcast.mock.calls.at(-1)?.[1]).toMatchObject({ publishing: null })
  })

  // Finding 2: destroyLane used to skip the lock entirely and never close
  // the lane's session first. Load-bearing on BOTH the ordering (session
  // closes before the worktree is touched) and the lock (a publish already
  // holding it must block a destroy of a DIFFERENT lane too — Phase 1 has
  // one lock for the whole conductor, not one per lane, exactly like
  // syncLane/reconcile's own reservations).
  it('destroyLane closes the session before destroying, and refuses while the lock is held, item 2', async () => {
    const order: string[] = []
    const closeSession = vi.fn((id: string) => { order.push(`close:${id}`) })
    const destroy = vi.fn(async () => { order.push('destroy') })
    const runtime = fakeRuntime({
      lanes: { destroy },
      createSession: vi.fn(async () => ({ id: 'sess-1' })),
      closeSession
    })
    const backend = createShippedConductorBackend(runtime as never)
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    // createLane doesn't itself attach a session (compose does); attach one
    // here so destroyLane has something to close.
    ;(created as ConductorLane).sessionId = 'sess-1'

    await backend.destroyLane(created.id)
    expect(order).toEqual(['close:sess-1', 'destroy'])
    expect(runtime.conductor.lockHolder()).toBeNull()

    // Now prove the refusal: reserve the lock as a stand-in for an in-flight
    // publish, and show destroy refuses rather than proceeding.
    const secondLane = await backend.createLane({ roleId: 'second', agent: { presetId: 'shell', model: null } })
    runtime.conductor.reserveLock('lane-second-publishing')
    await expect(backend.destroyLane(secondLane.id)).rejects.toThrow(/busy/i)
    expect(destroy).toHaveBeenCalledTimes(1)
    runtime.conductor.releaseLock('lane-second-publishing')
  })

  it('destroyLane leaves the lane in the map, not dropped, when lanes.destroy() fails to actually destroy it, item 2', async () => {
    const closeSession = vi.fn()
    const destroy = vi.fn(async () => { throw new Error('branch checked out elsewhere') })
    const runtime = fakeRuntime({ lanes: { destroy }, closeSession })
    const backend = createShippedConductorBackend(runtime as never)
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })

    await expect(backend.destroyLane(created.id)).rejects.toThrow('branch checked out elsewhere')
    const state = await backend.state()
    expect(state.lanes.map((l) => l.id)).toContain(created.id)
  })

  // Finding 3: createLane used to skip both validateRoster and maxLanes.
  it('createLane enforces maxLanes, item 3', async () => {
    const runtime = fakeRuntime({ settings: { maxLanes: 1 } })
    const backend = createShippedConductorBackend(runtime as never)
    await backend.createLane({ roleId: 'first', agent: { presetId: 'shell', model: null } })
    await expect(
      backend.createLane({ roleId: 'second', agent: { presetId: 'shell', model: null } })
    ).rejects.toThrow(/at most 1 lane/)
  })

  it('createLane enforces validateRoster\'s role-name rules (rejects a duplicate role name), item 3', async () => {
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never)
    await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    await expect(
      backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    ).rejects.toThrow(/duplicate role name/)
  })

  // Finding 4: conductor.reconcile() throws ConductorBusyError; the backend
  // must catch that at the boundary and return a structured, string-match-
  // free busy report instead of letting the throw cross into the IPC layer.
  it('translates a busy reconcile() throw into a structured busy report, item 4', async () => {
    const runtime = fakeRuntime({
      conductor: { reconcile: vi.fn(async () => { throw new ConductorBusyError() }) }
    })
    const backend = createShippedConductorBackend(runtime as never)
    await expect(backend.reconcile()).resolves.toEqual({ needsAttention: false, operations: [], busy: true })
  })

  it('still surfaces a genuinely completed reconcile report unchanged, item 4 (regression)', async () => {
    const report = { needsAttention: true, operations: [{ opId: '1', laneId: 'lane-1', classification: 'not-started' as const, summary: 's', safeToRedo: true, requiresHuman: false }] }
    const runtime = fakeRuntime({ conductor: { reconcile: vi.fn(async () => report) } })
    const backend = createShippedConductorBackend(runtime as never)
    await expect(backend.reconcile()).resolves.toEqual(report)
  })

  // Finding 5 (logged caveat b): while lastReconcile.needsAttention is true,
  // publishLane/syncLane must refuse with a reason distinguishable from
  // 'busy' — an unacknowledged interrupted operation must not be papered
  // over by a new publish or sync.
  it('publishLane and syncLane refuse with reason "needs-attention" while the last reconcile needs attention, item 5', async () => {
    const runtime = fakeRuntime({
      conductor: {
        reconcile: vi.fn(async () => ({
          needsAttention: true,
          operations: [{ opId: '1', laneId: 'lane-1', classification: 'interrupted-merge' as const, summary: 's', safeToRedo: false, requiresHuman: true }]
        }))
      }
    })
    const backend = createShippedConductorBackend(runtime as never)
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    await backend.reconcile()

    const publishOutcome = await backend.publishLane(created.id)
    expect(publishOutcome).toMatchObject({ ok: false, reason: 'needs-attention' })
    const syncOutcome = await backend.syncLane(created.id)
    expect(syncOutcome).toMatchObject({ ok: false, reason: 'needs-attention' })
    // conductor.publishLane/syncLane must never even be called: the gate is
    // at the backend boundary, before the runtime is touched at all.
    expect(runtime.conductor.publishLane).not.toHaveBeenCalled()
    expect(runtime.conductor.syncLane).not.toHaveBeenCalled()
  })

  it('a clean reconcile (needsAttention: false) does not gate publishLane/syncLane, item 5 (regression)', async () => {
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never)
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    await backend.reconcile()
    await expect(backend.publishLane(created.id)).resolves.toMatchObject({ ok: true })
  })

  // Finding 7: lanesById must hydrate from the store on construction and
  // persist on every mutation (create, compose, destroy), scoped to this
  // backend's own workspaceId only — never another workspace's lanes.
  it('hydrates lanesById from the store on construction, filtered to this workspace, item 7', async () => {
    const otherWorkspaceLane = lane({ id: 'lane-other', workspaceId: 'workspace-other' })
    const myLane = lane({ id: 'lane-mine', workspaceId: 'workspace-mine' })
    const loadLanes = vi.fn(() => [otherWorkspaceLane, myLane])
    const saveLanes = vi.fn()
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never, {
      workspaceId: 'workspace-mine', loadLanes, saveLanes
    })
    const state = await backend.state()
    expect(state.lanes.map((l) => l.id)).toEqual(['lane-mine'])
  })

  it('persists a created lane tagged with this workspaceId, without touching other workspaces\' records, item 7', async () => {
    const otherWorkspaceLane = lane({ id: 'lane-other', workspaceId: 'workspace-other' })
    const loadLanes = vi.fn(() => [otherWorkspaceLane])
    const saveLanes = vi.fn()
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never, {
      workspaceId: 'workspace-mine', loadLanes, saveLanes
    })
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })

    expect(saveLanes).toHaveBeenCalled()
    const saved = saveLanes.mock.calls.at(-1)?.[0] as ConductorLane[]
    expect(saved).toContainEqual(otherWorkspaceLane)
    expect(saved.find((l) => l.id === created.id)).toMatchObject({ workspaceId: 'workspace-mine' })
  })

  it('persists lanesById after destroyLane removes a lane, item 7', async () => {
    const saveLanes = vi.fn()
    let stored: ConductorLane[] = []
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never, {
      workspaceId: 'workspace-mine',
      loadLanes: () => stored,
      saveLanes: (list) => { stored = list; saveLanes(list) }
    })
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    await backend.destroyLane(created.id)

    expect(stored.find((l) => l.id === created.id)).toBeUndefined()
  })

  it('behaves exactly as before (in-memory only) when no persistence dependency is supplied, item 7 (regression)', async () => {
    const runtime = fakeRuntime()
    const backend = createShippedConductorBackend(runtime as never)
    const created = await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    const state = await backend.state()
    expect(state.lanes.map((l) => l.id)).toContain(created.id)
  })

  // Task 5, finding 2 (fix round 1): the store now drops any persisted lane
  // whose workspaceId is missing/empty/non-string, so this backend must
  // never be the one writing such a record in the first place, on ANY
  // mutation path — create, compose, and destroy (which re-persists the
  // surviving roster). Load-bearing: every element of every saveLanes()
  // call this test observes must carry this backend's own workspaceId,
  // and none may be blank.
  it('never writes a lane with a missing or blank workspaceId, on any mutation path (create, compose, destroy), item 2', async () => {
    const saveLanes = vi.fn()
    let stored: ConductorLane[] = []
    const runtime = fakeRuntime({
      createSession: vi.fn(async () => ({ id: 'sess-compose' }))
    })
    const backend = createShippedConductorBackend(runtime as never, {
      workspaceId: 'workspace-mine',
      loadLanes: () => stored,
      saveLanes: (list) => { stored = list; saveLanes(list) }
    })

    const assertAllStamped = (): void => {
      for (const call of saveLanes.mock.calls) {
        const list = call[0] as ConductorLane[]
        for (const l of list) {
          expect(typeof l.workspaceId).toBe('string')
          expect((l.workspaceId ?? '').length).toBeGreaterThan(0)
        }
      }
    }

    // create
    await backend.createLane({ roleId: 'builder', agent: { presetId: 'shell', model: null } })
    assertAllStamped()

    // compose
    await backend.compose({
      repo: runtime.settings.repo,
      integrationBranch: runtime.settings.integrationBranch,
      rows: [{ roleName: 'reviewer-row', kind: 'author' as const, agent: { presetId: 'shell', model: null } }],
      test: null
    })
    assertAllStamped()

    // destroy
    const survivor = stored.find((l) => l.roleId === 'builder')!
    await backend.destroyLane(survivor.id)
    assertAllStamped()

    expect(saveLanes).toHaveBeenCalled()
  })
})
