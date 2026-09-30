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
   *  decides what "now in force" means — Task 4 wires it to the live
   *  runtime's settings; persisting it to the store is a later task's job. */
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
  if (!samePath(draft.repo, deps.settings.repo)) {
    mismatches.push({ field: 'repo', message: 'this run was composed for a different repository' })
  }
  if (draft.integrationBranch.trim() !== deps.settings.integrationBranch.trim()) {
    mismatches.push({
      field: 'integrationBranch',
      message: 'this run was composed for a different integration branch'
    })
  }
  if (mismatches.length > 0) return { ok: false, errors: mismatches }

  await deps.lanes.ensureIntegrationWorktree()

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
