// Brings a conducted workspace into existence: integration worktree, then one
// lane and one session per roster row. All-or-nothing.

import { validateRoster, type ComposeResult, type RosterDraft } from '../shared/conductor-composer'
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
      await rollback(deps, created)
      return {
        ok: false,
        failedRow: index,
        message: error instanceof Error ? error.message : String(error),
        errors: []
      }
    }
  }

  return { ok: true, lanes: created }
}

async function rollback(deps: ComposeDeps, created: ConductorLane[]): Promise<void> {
  for (const lane of [...created].reverse()) {
    try {
      await deps.lanes.destroy(lane, { force: true })
    } catch (error) {
      // Report, never throw: a failure to clean up must not replace the real
      // cause of the failure with a second, less useful one.
      console.warn(`[crew] could not roll back lane ${lane.roleId}:`, error)
    }
  }
}
