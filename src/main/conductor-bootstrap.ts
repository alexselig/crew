// Task 6: the bootstrap module that binds Conductor to the active workspace.
//
// index.ts is effectively untestable under environment: 'node' (it imports
// electron), so every dependency this module needs — the store accessors, the
// userData directory, the session bridge, a clock, and the runtime/backend
// factories themselves — is injected. index.ts's job (Task 6's brief) is to
// be a thin call site supplying the real objects; this module owns the
// actual wiring decisions and is what gets exercised by tests.
//
// Two gaps the brief itself doesn't cover, resolved here (see task-6-report.md
// for the full rationale):
//
//  1. Chicken-and-egg: a workspace with no persisted ConductorConfig would
//     otherwise never be able to get one, because compose() needs a bound
//     runtime and a runtime needs a config. compose() closes that loop: the
//     first compose for a config-less workspace derives a ConductorConfig
//     from the draft (repo/integrationBranch from the draft; the on-disk
//     scratch paths from conductorPaths(), never from user input; maxLanes
//     from DEFAULT_MAX_LANES), persists it, binds a real runtime to it, and
//     only then composes. A workspace that already has a config skips all of
//     this — compose() reaches its existing runtime directly, so Task 4's
//     draft-vs-runtime rejection is exercised exactly as before.
//
//  2. Workspace switching: activeWorkspace can change at any time after IPC
//     is registered once. Every ConductorBackend this module ever binds is
//     cached per workspaceId for the lifetime of the process (see
//     `boundByWorkspace` below) — never rebuilt for a workspaceId already
//     bound once. That is what makes switching away and back safe: if an
//     operation is still holding that workspace's single-flight lock, the
//     cached backend's `state()` still reports the true holder, and a second
//     publish/sync against it still correctly reports 'busy' — because it is
//     genuinely the same Conductor instance, not a fresh one with an
//     amnesiac lock. Reconstructing a new runtime for an already-bound
//     workspace would risk two live Conductor instances touching the same
//     on-disk integration worktree at once; the cache makes that impossible.

import { IPC } from '../shared/types'
import type { ConductorConfig, ConductorLane } from '../shared/conductor'
import type { RosterDraft, ComposeResult } from '../shared/conductor-composer'
import {
  createShippedConductorBackend as realCreateShippedConductorBackend,
  type ConductorBackend,
  type ConductorRuntime,
  type ConductorLanePersistence
} from './conductor-ipc'
import {
  conductorPaths as realConductorPaths,
  createConductorRuntime as realCreateConductorRuntime
} from './conductor-runtime'
import type { ComposeDeps } from './conductor-compose'

/** No canonical default exists anywhere else in the codebase (checked: Task
 *  1-5 never hardcode one). Four is a deliberately modest Phase 1 ceiling —
 *  enough to run a small roster without inviting a git worktree sprawl no
 *  one asked for. Overridable via ConductorBootstrapDeps.maxLanes for a test
 *  or a future settings UI; nothing here treats it as sacred. */
export const DEFAULT_MAX_LANES = 4

type Broadcast = (channel: string, payload: unknown) => void

export interface ConductorBootstrapDeps {
  /** Electron's app.getPath('userData'), or a fake test directory. Never the
   *  user's repository — see conductorPaths()'s own doc comment. */
  userDataDir: string
  getConductorConfigs(): ConductorConfig[]
  saveConductorConfigs(list: ConductorConfig[]): ConductorConfig[]
  getConductorLanes(): ConductorLane[]
  saveConductorLanes(list: ConductorLane[]): ConductorLane[]
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
  /** Injectable clock, used only to timestamp the best-effort warning logged
   *  when the launch reconcile is guarded against a throw. */
  now?(): number
  maxLanes?: number
  // Factory seams. Defaulted to the real Task 2/5 implementations; overridden
  // in tests so this module's orchestration can be proven without a real git
  // repository or session manager.
  conductorPaths?: typeof realConductorPaths
  createConductorRuntime?: typeof realCreateConductorRuntime
  createShippedConductorBackend?: typeof realCreateShippedConductorBackend
}

export interface ConductorController {
  /** The one stable object handed to registerConductorIpc(). Every method
   *  resolves the currently bound workspace's backend at call time, so
   *  swapping which workspace is active never requires re-registering IPC. */
  backend: ConductorBackend
  /** Rebinds to `workspaceId`'s backend (or the disabled sentinel for
   *  null — "no workspace"). Cheap and synchronous: the actual runtime for a
   *  not-yet-seen workspaceId is constructed (and cached) lazily, on the
   *  first call any backend method makes after this. */
  setActiveWorkspace(workspaceId: string | null): void
  /** Runs reconcile() once against whatever is currently bound. A no-op,
   *  resolving cleanly, when nothing is bound (disabled state) — Conductor's
   *  plan explicitly forbids auto-resuming an interrupted operation, but an
   *  absent runtime has nothing to reconcile in the first place. Any throw —
   *  ConductorBusyError, MalformedJournalError, or anything else — is caught
   *  and logged, never allowed to reach the caller, so a corrupt journal or
   *  an unlikely startup race can never prevent the app from launching. */
  reconcileOnLaunch(broadcast: Broadcast): Promise<void>
}

interface BoundEntry {
  backend: ConductorBackend
  hasRuntime: boolean
}

const disabledEntry = (createBackend: typeof realCreateShippedConductorBackend): BoundEntry => ({
  backend: createBackend(null),
  hasRuntime: false
})

export function createConductorController(deps: ConductorBootstrapDeps): ConductorController {
  const conductorPaths = deps.conductorPaths ?? realConductorPaths
  const createConductorRuntimeFn = deps.createConductorRuntime ?? realCreateConductorRuntime
  const createShippedConductorBackendFn = deps.createShippedConductorBackend ?? realCreateShippedConductorBackend
  const maxLanes = deps.maxLanes ?? DEFAULT_MAX_LANES
  const now = deps.now ?? (() => Date.now())

  // Cached per workspaceId for the lifetime of this process. See the file
  // header for why this is what makes a switch-away-and-back safe: an
  // already-bound workspace is never reconstructed, so its Conductor's
  // single-flight lock is never silently reset out from under an operation
  // still genuinely in flight.
  const boundByWorkspace = new Map<string, BoundEntry>()
  const noWorkspaceEntry = disabledEntry(createShippedConductorBackendFn)
  let activeWorkspaceId: string | null = null

  const buildFromConfig = (config: ConductorConfig): BoundEntry => {
    const paths = conductorPaths(deps.userDataDir, config.workspaceId)
    const runtime: ConductorRuntime = createConductorRuntimeFn({
      config,
      journalPath: paths.journal,
      createSession: deps.createSession,
      closeSession: deps.closeSession
    })
    const persistence: ConductorLanePersistence = {
      workspaceId: config.workspaceId,
      loadLanes: deps.getConductorLanes,
      saveLanes: deps.saveConductorLanes
    }
    return { backend: createShippedConductorBackendFn(runtime, persistence), hasRuntime: true }
  }

  const getOrCreate = (workspaceId: string): BoundEntry => {
    const cached = boundByWorkspace.get(workspaceId)
    if (cached) return cached
    const config = deps.getConductorConfigs().find((c) => c.workspaceId === workspaceId)
    const entry = config ? buildFromConfig(config) : disabledEntry(createShippedConductorBackendFn)
    boundByWorkspace.set(workspaceId, entry)
    return entry
  }

  const currentEntry = (): BoundEntry =>
    activeWorkspaceId === null ? noWorkspaceEntry : getOrCreate(activeWorkspaceId)

  // Gap 1 (chicken-and-egg): the only place a ConductorConfig is ever
  // derived rather than user-authored. Runs exactly once per workspace — the
  // moment it succeeds, the resulting entry is cached under `workspaceId`,
  // so every later compose() for that workspace takes the "already
  // configured" branch below and reaches Task 4's real draft-vs-runtime
  // rejection untouched.
  const deriveAndBind = (workspaceId: string, draft: RosterDraft): BoundEntry => {
    const paths = conductorPaths(deps.userDataDir, workspaceId)
    const config: ConductorConfig = {
      workspaceId,
      repo: draft.repo,
      integrationBranch: draft.integrationBranch,
      integrationWorktree: paths.integrationWorktree,
      lanesDir: paths.lanesDir,
      maxLanes,
      // Never taken from the draft: Phase 1's test recipe is set later, once
      // a run actually succeeds (see conductor-ipc.ts's compose() —
      // setTestRecipe — and its own comment on why persisting that is a
      // later task's job, not this one's).
      test: null
    }
    const others = deps.getConductorConfigs().filter((c) => c.workspaceId !== workspaceId)
    deps.saveConductorConfigs([...others, config])
    const entry = buildFromConfig(config)
    boundByWorkspace.set(workspaceId, entry)
    return entry
  }

  const backend: ConductorBackend = {
    state: () => currentEntry().backend.state(),
    createLane: (request) => currentEntry().backend.createLane(request),
    destroyLane: (laneId) => currentEntry().backend.destroyLane(laneId),
    publishLane: (laneId) => currentEntry().backend.publishLane(laneId),
    syncLane: (laneId) => currentEntry().backend.syncLane(laneId),
    reconcile: () => currentEntry().backend.reconcile(),
    compose: (draft: RosterDraft): Promise<ComposeResult> => {
      if (activeWorkspaceId === null) {
        return Promise.reject(new Error('conductor: no active workspace to compose for'))
      }
      const entry = getOrCreate(activeWorkspaceId)
      const bound = entry.hasRuntime ? entry : deriveAndBind(activeWorkspaceId, draft)
      return bound.backend.compose(draft)
    }
  }

  return {
    backend,
    setActiveWorkspace(workspaceId) {
      activeWorkspaceId = workspaceId
      // Eager, not lazy: "rebinds to that workspace's config" (or the
      // disabled state) is the switch itself, not merely a hint for the next
      // backend call to act on — so a config already on disk is bound (and
      // cached) the moment the switch happens, before anything asks state()
      // for it.
      if (workspaceId !== null) getOrCreate(workspaceId)
    },
    async reconcileOnLaunch(broadcast) {
      const entry = currentEntry()
      if (!entry.hasRuntime) return
      try {
        await entry.backend.reconcile()
        broadcast(IPC.EVT_CONDUCTOR_STATE, await entry.backend.state())
      } catch (error) {
        // Guarded per the brief: ConductorBusyError, MalformedJournalError,
        // or anything else this can throw must never prevent the app from
        // starting. A run never auto-resumes on its own say-so anyway — the
        // renderer's needsAttention gate (Task 5) is what actually surfaces
        // an interrupted operation to the human, once the window can show
        // it. This is a last-resort, non-silent guard, exactly like
        // registerConductorIpc's own broadcast failure handling.
        console.warn(`[crew] conductor: launch reconcile failed at ${new Date(now()).toISOString()}:`, error)
      }
    }
  }
}
