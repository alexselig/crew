// Brings a conducted workspace into existence: integration worktree, then one
// lane and one session per roster row. All-or-nothing.

import {
  validateRoster,
  type CleanupFailure,
  type ComposeResult,
  type RosterDraft,
  type RosterError
} from '../shared/conductor-composer'
import type { LaneManager } from './lanes'
import type { ConductorLane, ConductorSettings, TestRecipe } from '../shared/conductor'
import { samePath } from './conductor-runtime'

export type { ComposeResult } from '../shared/conductor-composer'

export interface ComposeDeps {
  lanes: LaneManager
  settings: ConductorSettings
  /** Narrowed to what the composer needs, so this is testable without a PTY. */
  createSession(request: {
    cwd: string
    presetId: string
    model: string | null
    label: string
  }): Promise<{ id: string }>
  /** Tears a session down without touching its cwd. Rollback must call this
   *  BEFORE it removes the lane's worktree: a session whose cwd vanishes out
   *  from under it is exactly the orphan this composer exists to prevent. */
  closeSession(id: string): void
  /** Called once, only after every lane and session in the run has been
   *  created successfully, with the recipe the draft carried (null for
   *  none). This is the seam that lets the recipe reach the ConductorConfig
   *  the runtime actually uses, without composeRun reaching into settings
   *  (a shared object other in-flight code also reads) itself. The caller
   *  decides what "now in force" means: the shipped backend writes it to
   *  the live runtime's settings AND through to the persisted
   *  ConductorConfig, so it survives a restart (review finding 3). */
  setTestRecipe(recipe: TestRecipe | null): void
}

export async function composeRun(
  deps: ComposeDeps,
  draft: RosterDraft
): Promise<ComposeResult> {
  // 1. Everything decidable up front is decided up front.
  const validation = validateRoster(draft, { maxLanes: deps.settings.maxLanes })
  if (!validation.ok) return { ok: false, errors: validation.errors }

  // The app has no repository concept of its own — the draft the composer
  // built IS the source of truth for repo/integrationBranch (see Phase 1.5's
  // design decision). So rather than trusting draft.repo/integrationBranch
  // and silently building lanes in whatever repo the runtime happens to be
  // wired to (a wrong-target bug, review finding 4), a mismatch here is
  // rejected outright, before anything is created. Compared as paths, not
  // raw strings, so a trailing slash or a "./" segment is never a spurious
  // mismatch, while a genuinely different repo always is.
  const mismatches: RosterError[] = []
  let sameRepo: boolean
  try {
    sameRepo = samePath(draft.repo, deps.settings.repo)
  } catch (error) {
    // samePath fails closed rather than guessing when realpath can neither
    // resolve a path nor prove it absent (EACCES, ELOOP…). Review finding 6:
    // that used to throw across IPC and become an unhandled rejection in the
    // renderer. It is a refusal, not a crash — report it as one.
    return {
      ok: false,
      errors: [{
        field: 'repo',
        message: `could not check the repository path: ${error instanceof Error ? error.message : String(error)}`
      }]
    }
  }
  if (!sameRepo) {
    mismatches.push({ field: 'repo', message: 'this run was composed for a different repository' })
  }
  if (draft.integrationBranch.trim() !== deps.settings.integrationBranch.trim()) {
    mismatches.push({
      field: 'integrationBranch',
      message: 'this run was composed for a different integration branch'
    })
  }
  if (mismatches.length > 0) return { ok: false, errors: mismatches }

  // Review finding 6: this is the first thing that touches git, and it
  // fails for entirely ordinary reasons — a path that is not a repository,
  // an integration branch that does not exist yet (lanes.ts rev-parses it),
  // no permission to write the worktree. Thrown across IPC it became an
  // unhandled rejection the user never saw; returned, it is just another
  // reason the run could not start, rendered by the composer like any other.
  try {
    await deps.lanes.ensureIntegrationWorktree()
  } catch (error) {
    return {
      ok: false,
      errors: [{
        field: 'repo',
        message: `could not prepare the integration worktree: ${error instanceof Error ? error.message : String(error)}`
      }]
    }
  }

  const created: ConductorLane[] = []
  for (const [index, row] of draft.rows.entries()) {
    try {
      // 2. The worktree must exist before the session, because cwd is fixed at
      //    spawn and there is no setCwd.
      const lane = await deps.lanes.create(row.roleName, row.agent)
      created.push(lane)

      const session = await deps.createSession({
        cwd: lane.worktree,
        presetId: row.agent.presetId,
        model: row.agent.model,
        label: row.roleName
      })
      lane.sessionId = session.id
    } catch (error) {
      // 3. Roll back, newest first, so a lane is never left without its session.
      const { cleanupFailures, survivingLanes } = await rollback(deps, created)
      return {
        ok: false,
        failedRow: index,
        message: error instanceof Error ? error.message : String(error),
        errors: [],
        cleanupFailures,
        survivingLanes
      }
    }
  }

  // The recipe only ever takes effect once every lane/session in the run
  // exists — a rejected or rolled-back run must leave the recipe untouched,
  // the same way it leaves everything else untouched.
  deps.setTestRecipe(draft.test)

  return { ok: true, lanes: created }
}

async function rollback(
  deps: ComposeDeps,
  created: ConductorLane[]
): Promise<{ cleanupFailures: CleanupFailure[]; survivingLanes: ConductorLane[] }> {
  const cleanupFailures: CleanupFailure[] = []
  // Task 5, finding 3 (fix round 1): the actual lane objects rollback could
  // not remove, carried alongside cleanupFailures so the backend can
  // register and persist them — a lane that genuinely still exists on disk
  // must be known to someone, not merely announced-then-forgotten. Only a
  // lane whose WORKTREE survives goes here: a lane whose session alone
  // failed to close but whose worktree was still destroyed is gone, and
  // there is nothing left to recover.
  const survivingLanes: ConductorLane[] = []
  for (const lane of [...created].reverse()) {
    // The session must go first: it holds the lane's worktree as its cwd,
    // and a worktree removed out from under a still-running session is
    // exactly the orphan this rollback exists to prevent. So if closing it
    // throws, the worktree must NOT be deleted for this lane either — doing
    // so would recreate that same orphan (a live session whose cwd just
    // vanished). Skip this lane's worktree deletion and move on to the next
    // lane: one stuck session must not strand every other lane's cleanup.
    let sessionClosed = true
    if (lane.sessionId) {
      try {
        deps.closeSession(lane.sessionId)
      } catch (error) {
        sessionClosed = false
        // Report, never throw: a failure to clean up must not replace the
        // real cause of the failure with a second, less useful one — but it
        // must not be silently swallowed either, or an orphan becomes
        // invisible. Carried in the result instead of console.warn.
        cleanupFailures.push({
          resource: 'session',
          id: lane.sessionId,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (!sessionClosed) {
      // The worktree was never touched, and the session is still alive —
      // this lane, with the session id it already carries, still exists
      // exactly as it did before the run failed.
      survivingLanes.push(lane)
      continue
    }
    try {
      await deps.lanes.destroy(lane, { force: true })
    } catch (error) {
      cleanupFailures.push({
        resource: 'lane',
        id: lane.roleId,
        message: error instanceof Error ? error.message : String(error)
      })
      survivingLanes.push(lane)
    }
  }
  return { cleanupFailures, survivingLanes }
}
