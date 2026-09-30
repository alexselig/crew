// Brings a conducted workspace into existence: integration worktree, then one
// lane and one session per roster row. All-or-nothing.

import {
  validateRoster,
  type CleanupFailure,
  type ComposeResult,
  type RosterDraft
} from '../shared/conductor-composer'
import type { LaneManager } from './lanes'
import type { ConductorLane, ConductorSettings } from '../shared/conductor'

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
}

export async function composeRun(
  deps: ComposeDeps,
  draft: RosterDraft
): Promise<ComposeResult> {
  // 1. Everything decidable up front is decided up front.
  const validation = validateRoster(draft, { maxLanes: deps.settings.maxLanes })
  if (!validation.ok) return { ok: false, errors: validation.errors }

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
      const cleanupFailures = await rollback(deps, created)
      return {
        ok: false,
        failedRow: index,
        message: error instanceof Error ? error.message : String(error),
        errors: [],
        cleanupFailures
      }
    }
  }

  return { ok: true, lanes: created }
}

async function rollback(deps: ComposeDeps, created: ConductorLane[]): Promise<CleanupFailure[]> {
  const cleanupFailures: CleanupFailure[] = []
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
    if (!sessionClosed) continue
    try {
      await deps.lanes.destroy(lane, { force: true })
    } catch (error) {
      cleanupFailures.push({
        resource: 'lane',
        id: lane.roleId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return cleanupFailures
}
