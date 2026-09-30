// The bootstrap module: it owns every ConductorBackend the app has, one per
// workspace, and hands the right one to each IPC call.
//
// index.ts is effectively untestable under environment: 'node' (it imports
// electron), so every dependency this module needs — the store accessors, the
// userData directory, the session bridge, a clock, and the runtime/backend
// factories themselves — is injected. index.ts's job is to be a thin call
// site supplying the real objects; this module owns the actual wiring
// decisions and is what gets exercised by tests.
//
// Four decisions worth stating outright:
//
//  1. There is no "active workspace" here (review finding 1). There used to
//     be: main held one, fed only by the File → Change Workspace menu, while
//     each renderer window kept and persisted its OWN. After an ordinary
//     launch main's was null, so the panel showed `enabled: false` and
//     compose threw "no active workspace"; and picking A from the menu then
//     switching to B in the UI made compose write A's config with B's repo.
//     Two windows showing two workspaces could never both be right. So every
//     method here takes the workspace id from the CALL: `backendFor(wsId)`
//     resolves (building, if needed) that workspace's backend, and nothing
//     in this module remembers which workspace anyone is looking at.
//
//  2. Chicken-and-egg: a workspace with no persisted ConductorConfig could
//     otherwise never get one, because compose() needs a bound runtime and a
//     runtime needs a config. compose() closes that loop: the first compose
//     for a config-less workspace derives a ConductorConfig from the draft
//     (repo/integrationBranch from the draft; the on-disk scratch paths from
//     conductorPaths(), never from user input; maxLanes from
//     DEFAULT_MAX_LANES) and binds a runtime to it FOR THAT COMPOSE ONLY.
//     Review finding 4: the config is saved, and the backend cached, only
//     once the compose has actually succeeded — or failed leaving lanes
//     behind (survivingLanes), which must stay reachable. A failed first
//     compose (typo'd repo, missing integration branch) therefore leaves no
//     trace, instead of permanently locking the workspace into a config it
//     can never replace.
//
//  3. Every backend this module builds is cached per workspaceId for the
//     lifetime of the process (`boundByWorkspace`) — never rebuilt for a
//     workspaceId already bound. That is what makes switching away and back
//     safe: if an operation is still holding that workspace's single-flight
//     lock, the cached backend's `state()` still reports the true holder,
//     and a second publish/sync against it still correctly reports 'busy',
//     because it is genuinely the same Conductor instance rather than a
//     fresh one with an amnesiac lock. Two live Conductor instances on one
//     on-disk integration worktree are impossible by construction.
//
//  4. Every backend reconciles once, eagerly, the moment it is built (review
//     finding 2), and the result is broadcast. Publish and sync refuse until
//     that reconcile has completed, because a publish before the journal has
//     been read would become the newest operation and hide an interrupted
//     one for good.

import { IPC } from '../shared/types'
import type { ConductorConfig, ConductorLane, TestRecipe } from '../shared/conductor'
import type { RosterDraft, ComposeResult } from '../shared/conductor-composer'
import {
  canConduct,
  type Conflict,
  type MembershipSession,
  type MembershipWorkspace
} from '../shared/conductor-membership'
import {
  createShippedConductorBackend as realCreateShippedConductorBackend,
  type ConductorBackend,
  type ConductorRuntime,
  type ConductorPersistence
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

/** The subset of a Workspace this module needs to judge membership. */
export interface BootstrapWorkspace {
  id: string
  name: string
}

/** The subset of a persisted session this module needs to judge membership. */
export interface BootstrapSession {
  id: string
  label: string
  workspaceIds?: string[]
}

export interface ConductorBootstrapDeps {
  /** Electron's app.getPath('userData'), or a fake test directory. Never the
   *  user's repository — see conductorPaths()'s own doc comment. */
  userDataDir: string
  getConductorConfigs(): ConductorConfig[]
  saveConductorConfigs(list: ConductorConfig[]): ConductorConfig[]
  getConductorLanes(): ConductorLane[]
  saveConductorLanes(list: ConductorLane[]): ConductorLane[]
  /** Review finding 9: making a workspace conducted without checking whether
   *  its sessions already answer to another conducted workspace lets the
   *  next saveSessions() silently drop a membership. Both are optional so
   *  the module stays constructible without them; absent, the check is
   *  simply not performed (there is nothing to check against). */
  getWorkspaces?(): BootstrapWorkspace[]
  getSessions?(): BootstrapSession[]
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
  /** Where a backend's eager launch reconcile reports its result. Optional:
   *  without it the reconcile still runs (the gate still opens), it just
   *  reaches no window. */
  broadcast?: Broadcast
  /** Injectable clock, used only to timestamp best-effort warnings. */
  now?(): number
  maxLanes?: number
  // Factory seams. Defaulted to the real implementations; overridden in
  // tests so this module's orchestration can be proven without a real git
  // repository or session manager.
  conductorPaths?: typeof realConductorPaths
  createConductorRuntime?: typeof realCreateConductorRuntime
  createShippedConductorBackend?: typeof realCreateShippedConductorBackend
}

export interface ConductorController {
  /** The backend for one workspace, built on first use and cached after.
   *  `null` ("All Sessions") resolves to the disabled backend. This is what
   *  registerConductorIpc calls for every incoming request, so the
   *  workspace the CALLER named is the only thing that decides which
   *  conductor answers. */
  backendFor(workspaceId: string | null): ConductorBackend
  /** Compose for one workspace. Distinct from backendFor(ws).compose()
   *  because a workspace with no ConductorConfig yet has no runtime to
   *  compose with: this is the one place a config is derived, and the one
   *  place it is saved (only once the compose has actually succeeded). */
  compose(workspaceId: string | null, draft: RosterDraft): Promise<ComposeResult>
  /** Builds — and therefore eagerly reconciles — every workspace that
   *  already has a persisted ConductorConfig, and waits for those
   *  reconciles to settle. Run once at launch so an operation interrupted
   *  by a crash surfaces for EVERY conducted workspace, not merely for
   *  whichever one some window happens to open first. Never throws: a
   *  corrupt journal or a startup race must not stop the app launching. */
  reconcileOnLaunch(): Promise<void>
}

interface BoundEntry {
  backend: ConductorBackend
  hasRuntime: boolean
  /** The eager reconcile started when this entry was built; awaited by
   *  reconcileOnLaunch, never awaited by an ordinary IPC call. */
  reconciled?: Promise<void>
}

export function createConductorController(deps: ConductorBootstrapDeps): ConductorController {
  const conductorPaths = deps.conductorPaths ?? realConductorPaths
  const createConductorRuntimeFn = deps.createConductorRuntime ?? realCreateConductorRuntime
  const createShippedConductorBackendFn = deps.createShippedConductorBackend ?? realCreateShippedConductorBackend
  const maxLanes = deps.maxLanes ?? DEFAULT_MAX_LANES
  const now = deps.now ?? (() => Date.now())

  const boundByWorkspace = new Map<string, BoundEntry>()
  const noWorkspaceEntry: BoundEntry = {
    backend: createShippedConductorBackendFn(null),
    hasRuntime: false
  }

  const warn = (message: string, error: unknown): void => {
    console.warn(`[crew] conductor: ${message} at ${new Date(now()).toISOString()}:`, error)
  }

  /** Persists `config` as this workspace's record, replacing any earlier
   *  one and leaving every other workspace's untouched. */
  const storeConfig = (config: ConductorConfig): void => {
    const others = deps.getConductorConfigs().filter((c) => c.workspaceId !== config.workspaceId)
    deps.saveConductorConfigs([...others, config])
  }

  const persistenceFor = (config: ConductorConfig): ConductorPersistence => ({
    workspaceId: config.workspaceId,
    loadLanes: deps.getConductorLanes,
    saveLanes: deps.saveConductorLanes,
    // Review finding 3: the recipe a successful compose put in force must
    // reach the STORED config, or a restart reverts to `test: null` and
    // publishes stop running tests. `config` is the same object the runtime
    // was built from, so updating it keeps the in-memory and on-disk copies
    // in step — including on the first-compose path, where the config is
    // not written until the compose has succeeded (see compose() below).
    saveTestRecipe: (recipe: TestRecipe | null) => {
      config.test = recipe
      if (deps.getConductorConfigs().some((c) => c.workspaceId === config.workspaceId)) {
        storeConfig(config)
      }
    }
  })

  const buildFromConfig = (config: ConductorConfig): BoundEntry => {
    const paths = conductorPaths(deps.userDataDir, config.workspaceId)
    const runtime: ConductorRuntime = createConductorRuntimeFn({
      config,
      journalPath: paths.journal,
      createSession: deps.createSession,
      closeSession: deps.closeSession
    })
    return {
      backend: createShippedConductorBackendFn(runtime, persistenceFor(config)),
      hasRuntime: true
    }
  }

  /** Review finding 2: one reconcile per backend, started as soon as the
   *  backend exists rather than only at launch for whichever workspace
   *  happened to be bound. Until it completes, that backend refuses publish
   *  and sync (see conductor-ipc.ts's attentionRefusal), so this is what
   *  actually opens the gate — and what surfaces an operation interrupted
   *  by a crash. Guarded: ConductorBusyError, a malformed journal, or
   *  anything else must never escape into a launch path or an IPC call. */
  const startEagerReconcile = (workspaceId: string, entry: BoundEntry): void => {
    entry.reconciled = (async () => {
      try {
        await entry.backend.reconcile()
        deps.broadcast?.(IPC.EVT_CONDUCTOR_STATE, {
          workspaceId,
          state: await entry.backend.state()
        })
      } catch (error) {
        warn(`reconcile for workspace ${workspaceId} failed`, error)
      }
    })()
  }

  const bind = (workspaceId: string, config: ConductorConfig): BoundEntry => {
    const entry = buildFromConfig(config)
    boundByWorkspace.set(workspaceId, entry)
    startEagerReconcile(workspaceId, entry)
    return entry
  }

  const getOrCreate = (workspaceId: string): BoundEntry => {
    const cached = boundByWorkspace.get(workspaceId)
    if (cached) return cached
    const config = deps.getConductorConfigs().find((c) => c.workspaceId === workspaceId)
    if (!config) {
      // A workspace with no config is disabled, not broken. Cached so the
      // (cheap) disabled backend is stable, and replaced by compose() the
      // moment a real config is derived for it.
      const entry: BoundEntry = { backend: createShippedConductorBackendFn(null), hasRuntime: false }
      boundByWorkspace.set(workspaceId, entry)
      return entry
    }
    return bind(workspaceId, config)
  }

  const entryBackend = (workspaceId: string | null): ConductorBackend =>
    workspaceId === null ? noWorkspaceEntry.backend : getOrCreate(workspaceId).backend

  /** A per-workspace facade over the cached backends. Every method resolves
   *  its backend at call time (so a workspace bound between two calls is
   *  picked up), and `compose` routes through this module's own compose —
   *  the only path that may derive and save a ConductorConfig. */
  const backendFor = (workspaceId: string | null): ConductorBackend => ({
    state: () => entryBackend(workspaceId).state(),
    createLane: (request) => entryBackend(workspaceId).createLane(request),
    destroyLane: (laneId, options) => entryBackend(workspaceId).destroyLane(laneId, options),
    publishLane: (laneId) => entryBackend(workspaceId).publishLane(laneId),
    syncLane: (laneId) => entryBackend(workspaceId).syncLane(laneId),
    reconcile: () => entryBackend(workspaceId).reconcile(),
    compose: (draft) => compose(workspaceId, draft)
  })

  /** Review finding 9: canConduct answers "may this workspace be conducted,
   *  given who its sessions already answer to?". The graph it validates is
   *  strict (it throws on a duplicate or dangling id), and saveSessions is
   *  a hot path shared by the whole app that can produce exactly those —
   *  so the input is de-duplicated and narrowed to known workspaces first,
   *  and a throw is logged rather than turned into a compose refusal the
   *  user cannot act on. A real conflict verdict, though, is a refusal:
   *  conducting anyway would make the next saveSessions() silently drop one
   *  of the memberships. */
  const conductConflicts = (workspaceId: string): Conflict[] => {
    if (!deps.getWorkspaces || !deps.getSessions) return []
    try {
      const workspaces = deps.getWorkspaces()
      if (!workspaces.some((w) => w.id === workspaceId)) return []
      const conductedIds = new Set(deps.getConductorConfigs().map((c) => c.workspaceId))
      const knownIds = new Set(workspaces.map((w) => w.id))
      const membershipWorkspaces: MembershipWorkspace[] = workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        conducted: conductedIds.has(w.id) || w.id === workspaceId
      }))
      const seenSessionIds = new Set<string>()
      const membershipSessions: MembershipSession[] = []
      for (const session of deps.getSessions()) {
        if (!session.id || seenSessionIds.has(session.id)) continue
        seenSessionIds.add(session.id)
        membershipSessions.push({
          id: session.id,
          label: session.label,
          workspaceIds: [...new Set(session.workspaceIds ?? [])].filter((id) => knownIds.has(id))
        })
      }
      const verdict = canConduct(membershipWorkspaces, membershipSessions, workspaceId)
      return verdict.ok ? [] : verdict.conflicts
    } catch (error) {
      warn(`could not check membership exclusivity for workspace ${workspaceId}`, error)
      return []
    }
  }

  const describeConflicts = (conflicts: Conflict[]): string => {
    const detail = conflicts
      .map((c) => `${c.sessionLabel} already belongs to ${c.otherWorkspaceName}`)
      .join('; ')
    return `this workspace cannot be conducted: ${detail}. Move those sessions out of the other ` +
      `conducted workspace first — a session may be conducted by only one workspace.`
  }

  const compose = async (workspaceId: string | null, draft: RosterDraft): Promise<ComposeResult> => {
    if (workspaceId === null) {
      return {
        ok: false,
        errors: [{
          field: 'workspace',
          message: 'choose a workspace before composing a run — "All Sessions" is not a workspace'
        }]
      }
    }

    const existing = getOrCreate(workspaceId)
    if (existing.hasRuntime) return existing.backend.compose(draft)

    const conflicts = conductConflicts(workspaceId)
    if (conflicts.length > 0) {
      return { ok: false, errors: [{ field: 'workspace', message: describeConflicts(conflicts) }] }
    }

    // Derived in memory and bound for THIS compose only (review finding 4).
    const paths = conductorPaths(deps.userDataDir, workspaceId)
    const config: ConductorConfig = {
      workspaceId,
      repo: draft.repo,
      integrationBranch: draft.integrationBranch,
      integrationWorktree: paths.integrationWorktree,
      lanesDir: paths.lanesDir,
      maxLanes,
      // Never taken from the draft here: composeRun hands the draft's recipe
      // back through setTestRecipe once the run has fully succeeded, and
      // persistenceFor's saveTestRecipe writes it into this same object — so
      // the config saved below already carries it.
      test: null
    }
    const provisional = buildFromConfig(config)

    let result: ComposeResult
    try {
      result = await provisional.backend.compose(draft)
    } catch (error) {
      // A throw leaves nothing saved and nothing cached, exactly like an
      // ok: false with no survivors — the workspace is free to try again
      // with a different repo.
      boundByWorkspace.delete(workspaceId)
      throw error
    }

    const survivors = !result.ok && 'survivingLanes' in result && result.survivingLanes.length > 0
    if (result.ok || survivors) {
      // Saved only now. `survivors` counts because a lane rollback could not
      // remove genuinely exists on disk and must stay reachable — dropping
      // the config would make it invisible to every later session.
      storeConfig(config)
      boundByWorkspace.set(workspaceId, provisional)
      startEagerReconcile(workspaceId, provisional)
    } else {
      // Nothing was created, nothing is saved, and the workspace is NOT
      // left reporting enabled: true for a config that was never any good.
      boundByWorkspace.delete(workspaceId)
    }
    return result
  }

  return {
    backendFor,
    compose,
    async reconcileOnLaunch() {
      let configs: ConductorConfig[] = []
      try {
        configs = deps.getConductorConfigs()
      } catch (error) {
        warn('could not read conductor configs at launch', error)
        return
      }
      const pending: Promise<void>[] = []
      for (const config of configs) {
        try {
          const entry = getOrCreate(config.workspaceId)
          if (entry.reconciled) pending.push(entry.reconciled)
        } catch (error) {
          // e.g. an InvalidWorkspaceIdError from conductorPaths: one bad
          // record must not stop the others from being reconciled.
          warn(`could not bind workspace ${config.workspaceId} at launch`, error)
        }
      }
      await Promise.all(pending)
    }
  }
}
