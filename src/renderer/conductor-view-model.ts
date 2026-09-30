// Pure presentation rules for the conductor panel. No React, no window.crew —
// so the rules that decide what the user may press are tested in milliseconds
// under node rather than through a browser.

import type { ConductorSnapshot, LaneStatus, PublishOutcome } from '../shared/conductor'
import type { ProposalNote } from '../shared/conductor-proposal'
import type { ComposeResult } from '../shared/conductor-composer'

/** A manual edit to the composer's roster, as seen by the notes it can
 *  invalidate. Nothing here needs to know how the row itself changed —
 *  only which row, and whether it moved or vanished. */
export type RosterRowChange =
  | { type: 'update'; index: number }
  | { type: 'remove'; index: number }
  | { type: 'add' }

/**
 * A `ProposalNote` describes one row of a roster the agent proposed, at the
 * moment it was reconciled against reality. The instant the user edits,
 * removes, or adds a row by hand, that snapshot is stale: a note the user
 * has already fixed (or deleted outright) must not go on blocking Create.
 *
 * `add` never invalidates anything: a hand-added row starts with no note of
 * its own, and no existing row's index moves. `update` drops only the note
 * that describes the row that changed — the user may not have fixed it yet,
 * but whatever they typed replaces what the note was about, so the note no
 * longer describes the row that exists now. `remove` drops the removed
 * row's note and shifts every later row's note down one, because the array
 * itself just did the same shift.
 */
export function invalidateProposalNotes(notes: ProposalNote[], change: RosterRowChange): ProposalNote[] {
  if (change.type === 'add') return notes
  if (change.type === 'update') {
    return notes.filter((note) => note.row !== change.index)
  }
  // change.type === 'remove'
  return notes
    .filter((note) => note.row !== change.index)
    .map((note) => (note.row > change.index ? { ...note, row: note.row - 1 } : note))
}

export interface LaneRow {
  id: string
  roleId: string
  branch: string | null
  agentLabel: string
  status: LaneStatus
  statusDetail: string | null
  ahead: number
  behind: number
  publishing: boolean
  canPublish: boolean
  publishHint: string
  canSync: boolean
  syncHint: string
  warnings: string[]
}

/**
 * What the panel should render before it knows anything about a roster.
 * `null` (no snapshot has arrived from getConductorState()/onConductorState()
 * yet) is deliberately distinct from `'empty'` (a snapshot arrived and says
 * `enabled: false` — an ordinary, non-error state per Task 5/6): rendering
 * the "New conducted workspace" affordance during the brief unknown window
 * would flash it even for a workspace that turns out to already be
 * conducted, which a bare `snapshot != null && snapshot.enabled` check
 * cannot distinguish since both cases fail it the same way.
 */
export function conductorPanelMode(snapshot: ConductorSnapshot | null): 'loading' | 'empty' | 'active' {
  if (snapshot == null) return 'loading'
  return snapshot.enabled ? 'active' : 'empty'
}

export function buildRoster(snapshot: ConductorSnapshot): LaneRow[] {
  const locked = snapshot.publishing !== null

  return snapshot.lanes.map((lane) => {
    const facts = snapshot.facts[lane.id]
    const ahead = facts?.ahead ?? 0
    const behind = facts?.behind ?? 0

    const warnings: string[] = []
    if (facts?.dirtyTracked) warnings.push('uncommitted changes will not be published')
    if (facts?.untracked) warnings.push('untracked files will not be published')

    const canPublish = facts != null && ahead > 0 && !locked
    const canSync = facts != null && behind > 0 && !locked

    return {
      id: lane.id,
      roleId: lane.roleId,
      branch: lane.branch,
      agentLabel: lane.agent.model
        ? `${lane.agent.presetId} · ${lane.agent.model}`
        : lane.agent.presetId,
      status: lane.status,
      statusDetail: lane.blockedReason ?? null,
      ahead,
      behind,
      publishing: snapshot.publishing === lane.id,
      canPublish,
      publishHint: publishHint(facts != null, ahead, locked),
      canSync,
      syncHint: behind > 0 ? `${behind} commits behind` : 'up to date',
      warnings
    }
  })
}

function publishHint(measured: boolean, ahead: number, locked: boolean): string {
  if (!measured) return 'measuring…'
  if (locked) return 'publication in progress'
  if (ahead === 0) return 'nothing to publish'
  return `${ahead} commits ready`
}

export function describeOutcome(outcome: PublishOutcome): string {
  if (outcome.ok) return `Published ${outcome.commit.slice(0, 7)}`
  switch (outcome.reason) {
    case 'busy':
      return 'Another lane is publishing — try again in a moment'
    case 'nothing-to-publish':
      return 'Nothing to publish'
    case 'conflict':
      return `Conflict in ${outcome.conflictPaths.join(', ')} — resolve in the lane, then publish again`
    case 'tests-failed':
      return 'Tests failed on the merge result — nothing was published'
    case 'journal-failed':
      // NOT "nothing was run": conductor.ts writes this journal entry AFTER
      // the merge (sometimes after tests too) already happened — only the
      // durable RECORD of that step failed, not the step itself. The
      // integration worktree may hold a real, unrecorded merge commit, which
      // is exactly why this is a needs-attention condition, not a no-op.
      return `Could not durably record what happened — the integration worktree may be in an ` +
        `interim state and needs manual attention: ${outcome.message}`
    case 'ref-moved':
      return 'Someone else moved the integration branch — sync and publish again'
    case 'branch-checked-out':
      return 'The integration branch is checked out elsewhere — close that worktree first'
    default:
      return outcome.message
  }
}

/**
 * The publish/sync IPC calls reject on a transport-level failure (a thrown
 * preload/main error is never converted to a structured outcome — only a
 * BACKEND refusal is, per PublishOutcome/SyncOutcome). Left uncaught, that
 * is an unhandled promise rejection the user never sees. This is the text
 * for that path, distinct from describeOutcome's structured-refusal text.
 */
export function describeUnexpectedFailure(action: 'publish' | 'sync', error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `${action === 'publish' ? 'Publish' : 'Sync'} failed unexpectedly: ${detail}`
}

/**
 * The composer's submit failure text. A `ComposeResult` failure comes in two
 * shapes (src/shared/conductor-composer.ts): a pure client-side validation
 * miss (no partial run, `errors` only — the per-field messages already cover
 * it) or a run that started and failed partway (`message`, plus, since Task
 * 5's fix, `survivingLanes` — lanes rollback could NOT remove). The second
 * shape must never be reported as if it left nothing behind: a lane rollback
 * failed to clean up is still sitting on disk, and the user has to know.
 */
export function describeComposeFailure(result: ComposeResult): string | null {
  if (result.ok) return null
  if (!('message' in result)) {
    return 'Could not create the run — check the highlighted fields.'
  }
  if (result.survivingLanes.length === 0) return result.message
  const ids = result.survivingLanes.map((lane) => lane.roleId).join(', ')
  const plural = result.survivingLanes.length === 1 ? 'lane' : 'lanes'
  return `${result.message} ${result.survivingLanes.length} ${plural} could not be cleaned up and ` +
    `still exist on disk (${ids}) — remove ${result.survivingLanes.length === 1 ? 'it' : 'them'} manually before retrying.`
}
