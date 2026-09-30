// Pure presentation rules for the conductor panel. No React, no window.crew —
// so the rules that decide what the user may press are tested in milliseconds
// under node rather than through a browser.

import type { ConductorSnapshot, LaneStatus, PublishOutcome } from '../shared/conductor'
import type { ProposalNote } from '../shared/conductor-proposal'

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

export function shouldShowConductor(snapshot: ConductorSnapshot | null): snapshot is ConductorSnapshot {
  return snapshot != null && snapshot.enabled
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
      return `Could not record the operation, so nothing was run: ${outcome.message}`
    case 'ref-moved':
      return 'Someone else moved the integration branch — sync and publish again'
    case 'branch-checked-out':
      return 'The integration branch is checked out elsewhere — close that worktree first'
    default:
      return outcome.message
  }
}
