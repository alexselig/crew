// Conductor IPC. A standalone registrable module, following custom-view-ipc.ts,
// so the whole surface is testable under environment: 'node', without Electron.

import type { IpcMain } from 'electron'
import { IPC } from '../shared/types'
import type { LaneManager } from './lanes'
import { ConductorBusyError, type Conductor } from './conductor'
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
import { validateRoster, type ComposeResult, type RosterDraft, type RosterRow } from '../shared/conductor-composer'

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
  // to have changed and the renderer would be told a lie — this still holds
  // for CONDUCTOR_LANE_CREATE/DESTROY/COMPOSE below, whose validation runs
  // synchronously before anything is touched. CONDUCTOR_PUBLISH/SYNC are the
  // one exception (see their own comment): they broadcast once before the
  // outcome is even known, because by then the lock may already be taken,
  // and that transition is itself something the renderer needs to see. A
  // thrown error (including ConductorBusyError from the runtime) is never
  // re-wrapped here: ipcMain.handle already marshals a thrown error into a
  // rejected invoke() promise for the renderer, so it never becomes an
  // unhandled rejection and never leaks the actual main-process Error
  // instance across the bridge — only its message crosses, exactly like
  // every other thrown handler in this codebase (see custom-view-ipc.ts).
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
    // Finding 1: broadcast once before awaiting the outcome, not only after.
    // By the time backend.publishLane(laneId) returns a promise, the shipped
    // backend has already run its synchronous prefix into
    // conductor.publishLane and (if nothing about the lane/runtime was
    // invalid) the single-flight lock is already taken — so this first
    // publishState() is what lets the panel observe `publishing: true` for
    // the operation's whole duration, not merely its eventual result. The
    // second, in the finally, reports the lock released (or whatever else
    // changed) once the operation actually settles, exactly as before.
    const pending = backend.publishLane(laneId)
    await publishState()
    try {
      return await pending
    } finally {
      await publishState()
    }
  })

  ipc.handle(IPC.CONDUCTOR_SYNC, async (_event, laneId: string) => {
    const pending = backend.syncLane(laneId)
    await publishState()
    try {
      return await pending
    } finally {
      await publishState()
    }
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

/** Optional persistence for the shipped backend's lane roster (Task 5,
 *  finding 7). src/main/index.ts (Task 6) is the only real caller and is out
 *  of scope here, so this is injected rather than reached for directly —
 *  the backend must stay constructible, and must behave exactly as it does
 *  today (in-memory only, forgetting every lane on restart), when this is
 *  omitted. loadLanes/saveLanes are the store's own whole-collection
 *  get/save (Task 1: getConductorLanes/saveConductorLanes) — never
 *  per-record — so this backend, not the store, is what scopes them to one
 *  workspace; see hydrateLanes/persistLanes below for why. */
export interface ConductorLanePersistence {
  workspaceId: string
  loadLanes(): ConductorLane[]
  saveLanes(lanes: ConductorLane[]): void
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
export function createShippedConductorBackend(
  conductorRuntime: ConductorRuntime | null,
  persistence?: ConductorLanePersistence
): ConductorBackend {
  const lanesById = new Map<string, ConductorLane>()
  // Task 5, finding 5: the last reconcile report this backend has seen.
  // publishLane/syncLane consult its needsAttention flag below; an
  // unacknowledged interrupted operation must not be silently papered over
  // by a new publish or sync just because the lock itself is free.
  let lastReconcile: ReconcileReport = { needsAttention: false, operations: [] }

  // Finding 7: hydrated once, synchronously, at construction — every lane
  // this process will manage for this workspace must already be in
  // lanesById before the first state()/createLane() call, or an app
  // restart would silently forget every lane it didn't just create.
  // ConductorLane carries no workspace discriminator anywhere except the
  // optional `workspaceId` field added for exactly this purpose (see its
  // doc comment in src/shared/conductor.ts): lanes.create() never sets it,
  // only this backend does, when persisting. Filtering on it here is what
  // stops the store's one flat conductorLanes collection (Task 1 — never
  // indexed by workspace) from handing this backend another workspace's
  // lanes.
  if (persistence) {
    for (const lane of persistence.loadLanes()) {
      if (lane.workspaceId === persistence.workspaceId) lanesById.set(lane.id, lane)
    }
  }

  // Finding 7: re-reads the store fresh on every call (never trusts a
  // cached copy of "everyone else's lanes") so that two workspaces'
  // backends persisting concurrently in the same process cannot clobber
  // each other — each write only ever replaces this workspaceId's own
  // slice of the collection. Persistence is a durability nicety, not the
  // operation itself: a disk write failing must never turn an
  // already-succeeded mutation (the lane exists in memory, in git, in the
  // session bridge) into a rejected promise, so failures are logged and
  // swallowed, the same way registerConductorIpc's own broadcast failures
  // are.
  const persistLanes = (): void => {
    if (!persistence) return
    try {
      const others = persistence.loadLanes().filter((l) => l.workspaceId !== persistence.workspaceId)
      const mine = [...lanesById.values()].map((l) => ({ ...l, workspaceId: persistence.workspaceId }))
      persistence.saveLanes([...others, ...mine])
    } catch (error) {
      console.warn('[crew] conductor lane persistence failed:', error)
    }
  }

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
        // Task 5, finding 1: read straight from the runtime's own lock
        // instead of a backend-maintained shadow copy (see Conductor.
        // lockHolder's own doc comment for why the shadow copy was a lie).
        publishing: runtime.conductor.lockHolder(),
        lanes,
        facts,
        needsAttention: lastReconcile.needsAttention
      }
    },
    async createLane(request) {
      const runtime = requireWired()
      // Finding 3: createLane used to create a lane straight from the
      // request, enforcing neither maxLanes nor any of validateRoster's
      // other rules (legal/duplicate role names, a chosen agent, a model
      // for the presets that require one). Reusing validateRoster itself —
      // rather than re-deriving a parallel set of checks here — is what
      // guarantees a lane created one-at-a-time through this call is held
      // to exactly the same rules as one created through compose()'s
      // roster. The synthetic draft below exists purely to hand
      // validateRoster the full roster (every already-existing lane, plus
      // this new row) it needs to judge maxLanes and duplicate names; nothing
      // in it besides `rows` is actually used by validateRoster today, but
      // repo/integrationBranch are filled from the live settings anyway so a
      // future rule that does look at them sees the truth, not placeholders.
      const existingRows: RosterRow[] = [...lanesById.values()].map((l) => ({
        roleName: l.roleId, kind: l.kind, agent: l.agent
      }))
      const draft: RosterDraft = {
        repo: runtime.settings.repo,
        integrationBranch: runtime.settings.integrationBranch,
        // Phase 1 creates authors only; see ConductorLane.kind.
        rows: [...existingRows, { roleName: request.roleId, kind: 'author', agent: request.agent }],
        test: runtime.settings.test
      }
      const validation = validateRoster(draft, { maxLanes: runtime.settings.maxLanes })
      if (!validation.ok) {
        throw new Error(validation.errors.map((e) => `${e.field}: ${e.message}`).join('; '))
      }
      const lane = await runtime.lanes.create(request.roleId, request.agent)
      lanesById.set(lane.id, lane)
      persistLanes()
      return lane
    },
    async destroyLane(laneId) {
      const runtime = requireWired()
      const lane = requireLane(laneId)
      // Finding 2: destroying a lane must not race a publish/sync/reconcile
      // reading or merging that same worktree — Phase 1 has one lock for
      // the whole conductor, not one per lane, exactly like syncLane's own
      // reservation (see its comment in conductor.ts for why a
      // check-then-later-await isn't sufficient once anything awaits in
      // between). reserveLock is that same lock, taken for this call's
      // whole duration, released in the finally below.
      if (!runtime.conductor.reserveLock(laneId)) {
        throw new Error(`conductor is busy (${runtime.conductor.lockHolder()}); cannot destroy a lane right now`)
      }
      try {
        // The session must close before the worktree is touched: a session
        // whose cwd vanishes out from under it while still running is
        // exactly the orphan compose's own rollback exists to prevent (see
        // conductor-compose.ts's rollback()). If closing it throws, the
        // worktree must NOT be destroyed either — doing so would recreate
        // that same orphan (a session, now possibly still alive, whose cwd
        // just vanished) — so this call fails closed: the lane stays in
        // lanesById, on disk, and in the store, all three still agreeing
        // with each other.
        if (lane.sessionId) {
          runtime.closeSession(lane.sessionId)
        }
        // Only removed from lanesById once destroy() has actually
        // succeeded (finding 2's second half): if lanes.destroy() throws —
        // e.g. `git branch -d` refuses because the branch isn't fully
        // merged — the lane must stay in the map, because it still exists
        // on disk. Dropping it here regardless would tell state() (and
        // therefore the renderer) that a lane no longer exists when git
        // would tell a very different story.
        await runtime.lanes.destroy(lane, { force: false })
        lanesById.delete(laneId)
        persistLanes()
      } finally {
        runtime.conductor.releaseLock()
      }
    },
    async publishLane(laneId) {
      const { conductor } = requireWired()
      const lane = requireLane(laneId)
      // Finding 5 (logged caveat b): an unacknowledged interrupted
      // operation must not be silently papered over by a new publish. This
      // is checked here, at the backend boundary, before the runtime's own
      // lock is ever touched — conductor.publishLane is never called at
      // all while this holds, so it never even gets the chance to report
      // 'busy' instead.
      if (lastReconcile.needsAttention) {
        return {
          ok: false,
          reason: 'needs-attention',
          message: 'the last reconcile found an operation that still needs a human — resolve it before publishing'
        }
      }
      return conductor.publishLane(lane)
    },
    async syncLane(laneId) {
      const { conductor } = requireWired()
      const lane = requireLane(laneId)
      if (lastReconcile.needsAttention) {
        return {
          ok: false,
          reason: 'needs-attention',
          message: 'the last reconcile found an operation that still needs a human — resolve it before syncing'
        }
      }
      return conductor.syncLane(lane)
    },
    async reconcile() {
      const { conductor } = requireWired()
      // Finding 4: conductor.reconcile() throws ConductorBusyError when the
      // single-flight lock is already held (see conductor.ts's own doc
      // comment on that class for why it throws rather than returning a
      // failure shape — its contract is unchanged by this fix). Catching
      // it HERE, at the boundary the IPC surface actually depends on, is
      // what lets a caller learn "busy, try again" from data instead of
      // string-matching a thrown Error's message. Anything else conductor.
      // reconcile() might throw is a genuine, unexpected failure and is
      // deliberately allowed to propagate uncaught, exactly like every
      // other unhandled error in this backend.
      try {
        lastReconcile = await conductor.reconcile()
      } catch (error) {
        if (error instanceof ConductorBusyError) {
          return { needsAttention: false, operations: [], busy: true }
        }
        throw error
      }
      return lastReconcile
    },
    async compose(draft) {
      const runtime = requireWired()
      const result = await composeRun(
        {
          lanes: runtime.lanes,
          settings: runtime.settings,
          createSession: runtime.createSession,
          closeSession: runtime.closeSession,
          // Task 4's seam: composeRun calls this once a run fully succeeds.
          // Mutating runtime.settings here (rather than composeRun reaching
          // into it directly) keeps that write in the one layer that owns
          // the live runtime; persisting it to the store so it survives a
          // restart is a later task's job (this task's is only the lane
          // roster — see persistLanes above).
          setTestRecipe: (recipe) => { runtime.settings.test = recipe }
        },
        draft
      )
      if (result.ok) {
        for (const lane of result.lanes) lanesById.set(lane.id, lane)
        persistLanes()
      }
      return result
    }
  }
}
