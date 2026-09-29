// Conductor IPC. A standalone registrable module, following custom-view-ipc.ts,
// so the whole surface is testable under environment: 'node', without Electron.

import type { IpcMain } from 'electron'
import { IPC } from '../shared/types'
import type {
  ConductorSnapshot,
  LaneCreateRequest,
  ConductorLane,
  PublishOutcome,
  SyncOutcome,
  ReconcileReport
} from '../shared/conductor'

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
}
