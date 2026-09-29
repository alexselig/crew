// Pure presentation rules for the conductor panel. No React, no window.crew —
// so the rules that decide what the user may press are tested in milliseconds
// under node rather than through a browser.

import type { ConductorSnapshot, LaneStatus, PublishOutcome } from '../shared/conductor'

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
