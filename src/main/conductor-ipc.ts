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
    broadcast(IPC.EVT_CONDUCTOR_STATE, await backend.state())
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

  // Unlike the handlers above, this broadcasts only on success: a rejected
  // draft (validation errors, or a row that failed to spawn) rolls back
  // everything it created, so nothing about conductor state has changed.
  ipc.handle(IPC.CONDUCTOR_COMPOSE, async (_event, draft: RosterDraft) => {
    const result = await backend.compose(draft)
    if (result.ok) await publishState()
    return result
  })
}

export type ConductorRuntime = {
  lanes: LaneManager
  conductor: Conductor
  settings: ConductorSettings
  createSession: ComposeDeps['createSession']
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
      for (const lane of lanes) facts[lane.id] = await runtime.lanes.facts(lane)
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
        { lanes: runtime.lanes, settings: runtime.settings, createSession: runtime.createSession },
        draft
      )
      if (result.ok) {
        for (const lane of result.lanes) lanesById.set(lane.id, lane)
      }
      return result
    }
  }
}
