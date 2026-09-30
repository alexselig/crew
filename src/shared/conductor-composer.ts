// Pure roster validation. Everything decidable without touching the filesystem
// is decided here, before the composer creates anything, because a partially
// created run leaves worktrees the user cannot see.

import type { ConductorLane, LaneAgent, RoleKind, TestRecipe } from './conductor'

export interface RosterRow {
  roleName: string
  kind: RoleKind
  agent: LaneAgent
}

export interface RosterDraft {
  repo: string
  integrationBranch: string
  rows: RosterRow[]
  /** The test recipe the run should carry, or null for none. Phase 1 dropped
   *  this from the composer because nothing consumed it; a runtime now does
   *  (see ConductorConfig/ConductorSettings), so it is restored here. */
  test: TestRecipe | null
}

export interface RosterError {
  field: string
  message: string
}

export interface RosterValidation {
  ok: boolean
  errors: RosterError[]
}

/** Something composeRun's rollback could not undo after a row failed. Named
 *  so the renderer can tell the user "the lane you see in git is not tracked
 *  by Crew" instead of silently pretending the rollback was clean. */
export interface CleanupFailure {
  resource: 'lane' | 'session'
  /** roleId for a lane, session id for a session. */
  id: string
  message: string
}

// The outcome of composeRun (src/main/conductor-compose.ts). It lives here,
// not beside composeRun, because CrewAPI (src/shared/api.ts) exposes it to
// the renderer and neither renderer nor shared code may import from src/main.
export type ComposeResult =
  | { ok: true; lanes: ConductorLane[] }
  | { ok: false; errors: RosterError[] }
  | {
      ok: false
      failedRow: number
      message: string
      errors: RosterError[]
      /** Empty when rollback fully undid every lane/session it had created. */
      cleanupFailures: CleanupFailure[]
    }

/** Not a real preset: the composer form used to offer a "custom command"
 *  option, but RosterRow carries no fields to describe a custom command
 *  (only presetId/model), so a row using this sentinel could never be
 *  honoured by composeRun. Rejected explicitly so a stray value here fails
 *  loudly in validation instead of silently spawning nothing useful. */
export const UNSUPPORTED_CUSTOM_PRESET = '__custom__'

/** Presets whose launch takes a model. Mirrors the session form's own rule. */
const MODEL_PRESETS = new Set(['copilot-cli'])

export function laneBranchName(roleName: string): string {
  return `crew/lane/${roleName}`
}

// A conservative subset of git check-ref-format: the runtime re-checks with git
// itself, but the user should learn about a bad name while typing it.
const LEGAL_ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function validateRoster(
  draft: RosterDraft,
  limits: { maxLanes: number }
): RosterValidation {
  const errors: RosterError[] = []

  if (!draft.repo.trim()) errors.push({ field: 'repo', message: 'choose a repository' })
  if (!draft.integrationBranch.trim()) {
    errors.push({ field: 'integrationBranch', message: 'name the integration branch' })
  }

  if (draft.rows.length === 0) {
    errors.push({ field: 'rows', message: 'add at least one lane' })
  } else if (draft.rows.length > limits.maxLanes) {
    errors.push({
      field: 'rows',
      message: `at most ${limits.maxLanes} lane${limits.maxLanes === 1 ? '' : 's'}`
    })
  }

  const seen = new Set<string>()
  draft.rows.forEach((row, index) => {
    const name = row.roleName.trim()
    if (!name) {
      errors.push({ field: `rows[${index}].roleName`, message: 'name this lane' })
    } else if (!LEGAL_ROLE.test(name) || name.includes('..')) {
      errors.push({ field: `rows[${index}].roleName`, message: 'letters, digits, dot, dash and underscore only' })
    } else if (seen.has(name)) {
      errors.push({ field: `rows[${index}].roleName`, message: 'duplicate role name' })
    }
    seen.add(name)

    if (!row.agent.presetId || row.agent.presetId === UNSUPPORTED_CUSTOM_PRESET) {
      errors.push({ field: `rows[${index}].agent.presetId`, message: 'choose an agent' })
    } else if (MODEL_PRESETS.has(row.agent.presetId) && !row.agent.model) {
      errors.push({ field: `rows[${index}].agent.model`, message: 'choose a model' })
    } else if (!MODEL_PRESETS.has(row.agent.presetId) && row.agent.model) {
      errors.push({ field: `rows[${index}].agent.model`, message: 'this preset takes no model' })
    }

    // The integration branch is a real branch; a lane branch of the same name
    // would make publication merge a lane into itself.
    if (name && draft.integrationBranch.trim() === laneBranchName(name)) {
      errors.push({
        field: 'integrationBranch',
        message: `this is the branch lane "${name}" would use`
      })
    }
  })

  return { ok: errors.length === 0, errors }
}
