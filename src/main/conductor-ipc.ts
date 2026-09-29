// Conductor IPC. A standalone registrable module, following custom-view-ipc.ts,
// so the whole surface is testable under environment: 'node', without Electron.

import type { IpcMain } from 'electron'
import { IPC } from '../shared/types'
import type { LaneManager } from './lanes'
import type { Conductor } from './conductor'
import { composeRun, type ComposeDeps } from './conductor-compose'
import type {
  ConductorSnapshot,
  LaneCreateRequest,
  ConductorLane,
  ConductorSettings,
  LaneFacts,
  PublishOutcome,
  SyncOutcome,
  ReconcileReport
} from '../shared/conductor'
import type { ComposeResult, RosterDraft } from '../shared/conductor-composer'

// ConductorSnapshot, LaneCreateRequest and the other payload types are
// declared in src/shared/conductor.ts (Task 1) because the renderer reads
// them and must never import from src/main.

export interface ConductorBackend {
  state(): Promise<ConductorSnapshot>
  createLane(request: LaneCreateRequest): Promise<ConductorLane>
  destroyLane(laneId: string): Promise<void>
  publishLane(laneId: string): Promise<PublishOutcome>
  syncLane(laneId: string): Promise<SyncOutcome>
  reconcile(): Promise<ReconcileReport>
  compose(draft: RosterDraft): Promise<ComposeResult>
}

type Broadcast = (channel: string, payload: unknown) => void

export function registerConductorIpc(
  ipc: Pick<IpcMain, 'handle'>,
  backend: ConductorBackend,
  broadcast: Broadcast
): void {
  const publishState = async (): Promise<void> => {
    // Finding 5: this runs after a mutation has already committed (lane
    // created/destroyed, publish/sync outcome decided). A broadcast is a
    // side effect for other windows, not a load-bearing part of the
    // mutation the caller awaited — so a failure computing or sending it
    // must never turn an already-successful mutation into a rejected
    // promise. Swallow here (state() itself is now written to degrade
    // rather than throw for a single bad lane, so this is a last-resort
    // guard, not the primary defense).
    try {
      broadcast(IPC.EVT_CONDUCTOR_STATE, await backend.state())
    } catch (error) {
      // Fix 5: swallowed on purpose (see comment above), but not silently —
      // a broadcast that never reaches other windows should at least be
      // observable, the same way every other best-effort failure in main
      // logs rather than vanishes (see atomic-file.ts, handoff.ts, etc.).
      console.warn('[crew] conductor state broadcast failed:', error)
    }
  }

  ipc.handle(IPC.CONDUCTOR_STATE, () => backend.state())

  // Every mutating handler re-broadcasts, including on a rejected outcome: a
  // rejection still changes what the user should see (the lane is now
  // blocked). A thrown handler broadcasts nothing, because nothing is known
  // to have changed and the renderer would be told a lie. A thrown error
  // (including ConductorBusyError from the runtime) is never re-wrapped here:
  // ipcMain.handle already marshals a thrown error into a rejected
  // invoke() promise for the renderer, so it never becomes an unhandled
  // rejection and never leaks the actual main-process Error instance across
  // the bridge — only its message crosses, exactly like every other thrown
  // handler in this codebase (see custom-view-ipc.ts).
  ipc.handle(IPC.CONDUCTOR_LANE_CREATE, async (_event, request: LaneCreateRequest) => {
    const lane = await backend.createLane(request)
    await publishState()
    return lane
  })

  ipc.handle(IPC.CONDUCTOR_LANE_DESTROY, async (_event, laneId: string) => {
    await backend.destroyLane(laneId)
    await publishState()
  })

  ipc.handle(IPC.CONDUCTOR_PUBLISH, async (_event, laneId: string) => {
    const outcome = await backend.publishLane(laneId)
    await publishState()
    return outcome
  })

  ipc.handle(IPC.CONDUCTOR_SYNC, async (_event, laneId: string) => {
    const outcome = await backend.syncLane(laneId)
    await publishState()
    return outcome
  })

  ipc.handle(IPC.CONDUCTOR_RECONCILE, () => backend.reconcile())

  // A rejected draft (validation errors, or a row that failed to spawn)
  // normally rolls back everything it created, so nothing about conductor
  // state has changed and no broadcast is needed. But when rollback itself
  // fails to fully undo what it created (a lane or a session survives), state
  // HAS changed — the premise "nothing to see" no longer holds — so that case
  // broadcasts too, same as every other mutating handler above.
  ipc.handle(IPC.CONDUCTOR_COMPOSE, async (_event, draft: RosterDraft) => {
    const result = await backend.compose(draft)
    const cleanupFailed = !result.ok && 'cleanupFailures' in result && result.cleanupFailures.length > 0
    if (result.ok || cleanupFailed) await publishState()
    return result
  })
}

export type ConductorRuntime = {
  lanes: LaneManager
  conductor: Conductor
  settings: ConductorSettings
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
}

// The shipped backend, extracted from src/main/index.ts so its disabled path
// (runtime === null) is exercisable under environment: 'node' the same way
// registerConductorIpc is. Built independent of `manager`/`store`, because a
// lane's git identity has nothing to do with a session's PTY identity: the
// IPC surface deals in lane ids, the runtime in lane objects (per Task 9's
// brief), so this backend is the one place that resolves one to the other.
// No composer exists yet to produce real ConductorSettings (repo path,
// integration branch/worktree, lanes dir, test recipe) — that lands in a
// later task. Until wired, index.ts passes null and the backend reports
// itself disabled rather than guessing at settings.
export function createShippedConductorBackend(conductorRuntime: ConductorRuntime | null): ConductorBackend {
  const lanesById = new Map<string, ConductorLane>()
  let publishingLaneId: string | null = null
  let lastReconcile: ReconcileReport = { needsAttention: false, operations: [] }

  const requireWired = (): ConductorRuntime => {
    if (!conductorRuntime) throw new Error('conductor is not configured for this workspace yet')
    return conductorRuntime
  }

  const requireLane = (laneId: string): ConductorLane => {
    const lane = lanesById.get(laneId)
    if (!lane) throw new Error(`unknown lane: ${laneId}`)
    return lane
  }

  return {
    async state() {
      const runtime = conductorRuntime
      if (!runtime) {
        return { enabled: false, publishing: null, lanes: [], facts: {}, needsAttention: false }
      }
      const lanes = [...lanesById.values()]
      const facts: Record<string, LaneFacts> = {}
      // Finding 5: computed in sequence, so one lane whose worktree is gone
      // (e.g. destroy() removed the worktree but left the lane in the map
      // because `git branch -d` failed) must not abort every other lane's
      // facts, and must not throw out of state() at all. A missing entry
      // here is already a degraded-lane signal the renderer understands:
      // conductor-view-model.ts's buildRoster treats `facts[lane.id] ===
      // undefined` as "measuring…", with canPublish/canSync both false —
      // exactly the "blocked, don't let the user act on it" posture this
      // finding asks for, with no new wire shape needed.
      for (const lane of lanes) {
        try {
          facts[lane.id] = await runtime.lanes.facts(lane)
        } catch {
          // Deliberately omitted — see comment above.
        }
      }
      return {
        enabled: true,
        publishing: publishingLaneId,
        lanes,
        facts,
        needsAttention: lastReconcile.needsAttention
      }
    },
    async createLane(request) {
      const { lanes } = requireWired()
      const lane = await lanes.create(request.roleId, request.agent)
      lanesById.set(lane.id, lane)
      return lane
    },
    async destroyLane(laneId) {
      const { lanes } = requireWired()
      const lane = requireLane(laneId)
      await lanes.destroy(lane, { force: false })
      lanesById.delete(laneId)
    },
    async publishLane(laneId) {
      const { conductor } = requireWired()
      const lane = requireLane(laneId)
      publishingLaneId = laneId
      try {
        return await conductor.publishLane(lane)
      } finally {
        publishingLaneId = null
      }
    },
    async syncLane(laneId) {
      const { conductor } = requireWired()
      const lane = requireLane(laneId)
      publishingLaneId = laneId
      try {
        return await conductor.syncLane(lane)
      } finally {
        publishingLaneId = null
      }
    },
    async reconcile() {
      const { conductor } = requireWired()
      lastReconcile = await conductor.reconcile()
      return lastReconcile
    },
    async compose(draft) {
      const runtime = requireWired()
      const result = await composeRun(
        {
          lanes: runtime.lanes,
          settings: runtime.settings,
          createSession: runtime.createSession,
          closeSession: runtime.closeSession
        },
        draft
      )
      if (result.ok) {
        for (const lane of result.lanes) lanesById.set(lane.id, lane)
      }
      return result
    }
  }
}
