// Conductor IPC. A standalone registrable module, following custom-view-ipc.ts,
// so the whole surface is testable under environment: 'node', without Electron.

import type { IpcMain } from 'electron'
import { IPC } from '../shared/types'
import type { LaneManager } from './lanes'
import { ConductorBusyError, type Conductor } from './conductor'
import { composeRun, type ComposeDeps } from './conductor-compose'
import type {
  ConductorSnapshot,
  TestRecipe,
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
  /** `force` skips the "is this lane's work already published?" gate AND
   *  passes force through to git. Without it, a lane carrying unpublished
   *  commits is refused BEFORE its session is killed (review finding 8). */
  destroyLane(laneId: string, options?: { force?: boolean }): Promise<void>
  publishLane(laneId: string): Promise<PublishOutcome>
  syncLane(laneId: string): Promise<SyncOutcome>
  reconcile(): Promise<ReconcileReport>
  compose(draft: RosterDraft): Promise<ComposeResult>
}

/** Resolves the backend for one workspace. Review finding 1: main used to
 *  hold a single "active workspace" of its own, fed only by the File menu,
 *  so conductor was bound to the wrong workspace (or, after an ordinary
 *  launch, to none) whenever the user switched workspaces in the UI — and
 *  could never be right for two windows showing two workspaces at once.
 *  Every handler below now takes the workspace id from its own call and
 *  resolves the backend through this, so the caller's workspace is the only
 *  thing that decides which conductor answers. `null` ("All Sessions")
 *  resolves to the disabled backend. */
export type ConductorBackendFor = (workspaceId: string | null) => ConductorBackend

type Broadcast = (channel: string, payload: unknown) => void

/** The wire shape of every mutating conductor channel: the workspace id
 *  always travels with the payload. */
interface LaneMessage { workspaceId: string | null; laneId: string; force?: boolean }
interface CreateMessage { workspaceId: string | null; request: LaneCreateRequest }
interface ComposeMessage { workspaceId: string | null; draft: RosterDraft }

export function registerConductorIpc(
  ipc: Pick<IpcMain, 'handle'>,
  backendFor: ConductorBackendFor,
  broadcast: Broadcast
): void {
  const publishState = async (workspaceId: string | null): Promise<void> => {
    // Finding 5: this runs after a mutation has already committed (lane
    // created/destroyed, publish/sync outcome decided). A broadcast is a
    // side effect for other windows, not a load-bearing part of the
    // mutation the caller awaited — so a failure computing or sending it
    // must never turn an already-successful mutation into a rejected
    // promise. Swallow here (state() itself is now written to degrade
    // rather than throw for a single bad lane, so this is a last-resort
    // guard, not the primary defense).
    try {
      const state = await backendFor(workspaceId).state()
      broadcast(IPC.EVT_CONDUCTOR_STATE, { workspaceId, state })
    } catch (error) {
      // Fix 5: swallowed on purpose (see comment above), but not silently —
      // a broadcast that never reaches other windows should at least be
      // observable, the same way every other best-effort failure in main
      // logs rather than vanishes (see atomic-file.ts, handoff.ts, etc.).
      console.warn('[crew] conductor state broadcast failed:', error)
    }
  }

  ipc.handle(IPC.CONDUCTOR_STATE, (_event, workspaceId: string | null) => backendFor(workspaceId).state())

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
  ipc.handle(IPC.CONDUCTOR_LANE_CREATE, async (_event, message: CreateMessage) => {
    const lane = await backendFor(message.workspaceId).createLane(message.request)
    await publishState(message.workspaceId)
    return lane
  })

  ipc.handle(IPC.CONDUCTOR_LANE_DESTROY, async (_event, message: LaneMessage) => {
    await backendFor(message.workspaceId).destroyLane(message.laneId, { force: message.force === true })
    await publishState(message.workspaceId)
  })

  ipc.handle(IPC.CONDUCTOR_PUBLISH, async (_event, message: LaneMessage) => {
    // Finding 1: broadcast once before awaiting the outcome, not only after.
    // By the time backend.publishLane(laneId) returns a promise, the shipped
    // backend has already run its synchronous prefix into
    // conductor.publishLane and (if nothing about the lane/runtime was
    // invalid) the single-flight lock is already taken — so this first
    // publishState() is what lets the panel observe `publishing: true` for
    // the operation's whole duration, not merely its eventual result. The
    // second, in the finally, reports the lock released (or whatever else
    // changed) once the operation actually settles, exactly as before.
    const pending = backendFor(message.workspaceId).publishLane(message.laneId)
    await publishState(message.workspaceId)
    try {
      return await pending
    } finally {
      await publishState(message.workspaceId)
    }
  })

  ipc.handle(IPC.CONDUCTOR_SYNC, async (_event, message: LaneMessage) => {
    const pending = backendFor(message.workspaceId).syncLane(message.laneId)
    await publishState(message.workspaceId)
    try {
      return await pending
    } finally {
      await publishState(message.workspaceId)
    }
  })

  // Reconcile is how the user gets OUT of the needs-attention gate (review
  // finding 7), so its result must reach every window, not only the caller:
  // a reconcile that finds everything complete clears the gate, and the
  // panel's Publish/Sync buttons must stop being refused accordingly.
  ipc.handle(IPC.CONDUCTOR_RECONCILE, async (_event, workspaceId: string | null) => {
    const report = await backendFor(workspaceId).reconcile()
    await publishState(workspaceId)
    return report
  })

  // A rejected draft (validation errors, or a row that failed to spawn)
  // normally rolls back everything it created, so nothing about conductor
  // state has changed and no broadcast is needed. But when rollback itself
  // fails to fully undo what it created (a lane or a session survives), state
  // HAS changed — the premise "nothing to see" no longer holds — so that case
  // broadcasts too, same as every other mutating handler above.
  ipc.handle(IPC.CONDUCTOR_COMPOSE, async (_event, message: ComposeMessage) => {
    const result = await backendFor(message.workspaceId).compose(message.draft)
    const cleanupFailed = !result.ok && 'cleanupFailures' in result && result.cleanupFailures.length > 0
    if (result.ok || cleanupFailed) await publishState(message.workspaceId)
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

/** Optional persistence for everything the shipped backend must remember
 *  across a restart: its lane roster, and the test recipe a successful
 *  compose put in force. Injected rather than reached for directly (the
 *  backend must stay constructible, and behave exactly as it does today —
 *  in-memory only — when this is omitted); conductor-bootstrap.ts supplies
 *  the real store-backed implementation. loadLanes/saveLanes are the
 *  store's own whole-collection get/save (getConductorLanes/
 *  saveConductorLanes) — never per-record — so this backend, not the store,
 *  is what scopes them to one workspace; see persistLanes below for why. */
export interface ConductorPersistence {
  workspaceId: string
  loadLanes(): ConductorLane[]
  saveLanes(lanes: ConductorLane[]): void
  /** Review finding 3: a test recipe entered in the composer used to reach
   *  only the LIVE runtime settings, so after a restart the persisted
   *  config still said `test: null` and every publish silently skipped the
   *  tests it was supposed to gate on. Writing it through here is what
   *  makes the recipe survive. Optional so a backend without persistence
   *  behaves exactly as before. */
  saveTestRecipe?(recipe: TestRecipe | null): void
}

// The shipped backend: one per conducted workspace, built by
// conductor-bootstrap.ts. Extracted from src/main/index.ts so its disabled
// path (runtime === null) is exercisable under environment: 'node' the same
// way registerConductorIpc is. Built independent of `manager`/`store`,
// because a lane's git identity has nothing to do with a session's PTY
// identity: the IPC surface deals in lane ids, the runtime in lane objects,
// so this backend is the one place that resolves one to the other. A
// workspace with no ConductorConfig gets `runtime === null`, and the backend
// reports itself disabled — a normal capability state, never an error.
export function createShippedConductorBackend(
  conductorRuntime: ConductorRuntime | null,
  persistence?: ConductorPersistence
): ConductorBackend {
  const lanesById = new Map<string, ConductorLane>()
  // Task 5, finding 5: the last reconcile report this backend has seen.
  // publishLane/syncLane consult its needsAttention flag below; an
  // unacknowledged interrupted operation must not be silently papered over
  // by a new publish or sync just because the lock itself is free.
  let lastReconcile: ReconcileReport = { needsAttention: false, operations: [] }
  // Review finding 2: `lastReconcile` defaulting to needsAttention: false
  // meant the gate was OFF until a reconcile had run — and nothing
  // guaranteed one ever did. A publish before the first reconcile writes
  // journal entries of its own, making it the newest operation, and
  // reconcile only ever classifies the newest one — so an operation
  // interrupted by a crash would be hidden for good. Publish and sync are
  // therefore refused until one reconcile has actually COMPLETED for this
  // backend (a 'busy' reconcile has not: it never read the journal).
  // conductor-bootstrap.ts starts that reconcile eagerly the moment a
  // backend is built, so this is normally clear within milliseconds.
  let reconciled = false

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

  /** The one place publish and sync decide to stand down. Two distinct
   *  situations, one reason code, because the caller's options are the same
   *  in both: run a reconcile and look at what it says.
   *  - not reconciled yet: the journal has not been read since launch, so
   *    an interrupted operation may be sitting there unseen (review
   *    finding 2).
   *  - reconciled, and it found something needing a human (Task 5,
   *    finding 5).
   *  Returned, never thrown: publish/sync report refusals as data — only
   *  conductor.reconcile() throws (ConductorBusyError). */
  const attentionRefusal = (
    verb: 'publishing' | 'syncing'
  ): { ok: false; reason: 'needs-attention'; message: string } | null => {
    if (!reconciled) {
      return {
        ok: false,
        reason: 'needs-attention',
        message: 'conductor has not finished checking for interrupted operations yet — re-check, then try again'
      }
    }
    if (lastReconcile.needsAttention) {
      return {
        ok: false,
        reason: 'needs-attention',
        message: `the last reconcile found an operation that still needs a human — resolve it before ${verb}`
      }
    }
    return null
  }

  return {
    async state() {
      const runtime = conductorRuntime
      if (!runtime) {
        return {
          enabled: false, publishing: null, lanes: [], facts: {},
          // reconciled: true, not false — a workspace with no conductor
          // config has no journal to read and nothing that could have been
          // interrupted, so the gate publish/sync sit behind is open, not
          // pending. Its refusal is 'not configured', never 'still checking'.
          needsAttention: false, operations: [], reconciled: true
        }
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
        needsAttention: lastReconcile.needsAttention,
        // Named, not merely counted: the panel has to tell the user WHICH
        // operation is holding publish and sync (review finding 7).
        operations: lastReconcile.operations,
        reconciled
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
    async destroyLane(laneId, options = {}) {
      const runtime = requireWired()
      const lane = requireLane(laneId)
      const force = options.force === true
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
        // Review finding 8: this check must happen BEFORE the session is
        // closed. lanes.destroy({ force: false }) refuses any lane whose
        // branch is not merged — the usual case — so the old order killed
        // the agent and then failed, leaving a lane that still exists on
        // disk pointing at a dead session id. Asking for the facts first
        // means an unpublished lane is refused while its agent is still
        // running, and the caller is told to publish or pass force.
        if (!force) {
          let unpublished = 0
          try {
            unpublished = (await runtime.lanes.facts(lane)).ahead
          } catch (error) {
            // Facts are unmeasurable (worktree already gone, git broken):
            // this cannot PROVE there is unpublished work, and refusing
            // here would leave a broken lane undestroyable through any
            // path at all. Proceed, but never silently.
            console.warn(`[crew] conductor: could not measure lane ${lane.roleId} before destroy:`, error)
          }
          if (unpublished > 0) {
            throw new Error(
              `lane ${lane.roleId} has ${unpublished} unpublished commit(s) — publish them, or destroy it with force`
            )
          }
        }
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
          // Review finding 8's second half: the session is gone, so the
          // lane must stop claiming it immediately — even if the destroy
          // below fails and the lane survives, it must never be left
          // carrying a dead session id.
          lane.sessionId = null
          persistLanes()
        }
        // Only removed from lanesById once destroy() has actually
        // succeeded (finding 2's second half): if lanes.destroy() throws —
        // e.g. `git branch -d` refuses because the branch isn't fully
        // merged — the lane must stay in the map, because it still exists
        // on disk. Dropping it here regardless would tell state() (and
        // therefore the renderer) that a lane no longer exists when git
        // would tell a very different story.
        await runtime.lanes.destroy(lane, { force })
        lanesById.delete(laneId)
        persistLanes()
      } finally {
        // Task 5, finding 1: releaseLock() is now ownership-checked, so this
        // must pass the exact holder string reserveLock(laneId) used above —
        // otherwise a legitimate release would itself be silently ignored.
        runtime.conductor.releaseLock(laneId)
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
      const refusal = attentionRefusal('publishing')
      if (refusal) return refusal
      return conductor.publishLane(lane)
    },
    async syncLane(laneId) {
      const { conductor } = requireWired()
      const lane = requireLane(laneId)
      const refusal = attentionRefusal('syncing')
      if (refusal) return refusal
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
        // Only a reconcile that actually ran clears the gate. A busy one
        // (below) never read the journal, so it proves nothing.
        reconciled = true
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
          // the live runtime. Review finding 3: the recipe must ALSO reach
          // the persisted ConductorConfig, or a restart silently reverts to
          // `test: null` and every later publish skips the tests it was
          // supposed to gate on. Persisting is best-effort in the same
          // sense persistLanes is — the live runtime is already correct —
          // so a failing write is logged, never thrown back into a compose
          // that otherwise succeeded.
          setTestRecipe: (recipe) => {
            runtime.settings.test = recipe
            try {
              persistence?.saveTestRecipe?.(recipe)
            } catch (error) {
              console.warn('[crew] conductor test recipe persistence failed:', error)
            }
          }
        },
        draft
      )
      if (result.ok) {
        for (const lane of result.lanes) lanesById.set(lane.id, lane)
        persistLanes()
      } else if ('survivingLanes' in result && result.survivingLanes.length > 0) {
        // Task 5, finding 3 (fix round 1): a lane rollback could not remove
        // really exists on disk — the user must be able to see it and
        // destroy it, exactly like any other lane this backend knows
        // about. Registered and persisted the same way a successful
        // compose's lanes are; the only difference is these came back on
        // the failure arm of ComposeResult.
        for (const lane of result.survivingLanes) lanesById.set(lane.id, lane)
        persistLanes()
      }
      return result
    }
  }
}
