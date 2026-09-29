// A lane session belongs to at most ONE conducted workspace.
//
// The "only one workspace is open at a time" intuition does not hold:
// activeWorkspace is a per-window view preference (readViewPref, namespaced by
// window slot in window-scope.ts), so two windows can have two workspaces
// active at once, and conducting must survive switching away. "Active" (view)
// and "conducting" (runtime) are therefore decoupled, and exclusivity is
// enforced here, on membership data alone. Pure: no IO, no imports from
// main/, no clock, no randomness.

export interface MembershipWorkspace {
  id: string
  name: string
  conducted?: boolean
}

export interface MembershipSession {
  id: string
  label: string
  workspaceIds?: string[]
}

export interface Conflict {
  sessionId: string
  sessionLabel: string
  otherWorkspaceId: string
  otherWorkspaceName: string
}

export type MembershipVerdict = { ok: true } | { ok: false; conflicts: Conflict[] }

/**
 * Thrown when the workspaces/sessions given cannot describe a valid
 * membership graph: an empty or duplicated id, or a session that names a
 * workspace outside the given set. Follows the precedent set by
 * MalformedJournalError (conductor-recovery.ts) — malformed input must be
 * surfaced, never silently classified as a valid (and possibly unsafe)
 * answer.
 */
export class MalformedMembershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedMembershipError'
  }
}

/** Renders an arbitrary value for an error message without itself throwing,
 *  even if `value` is a value whose toString/JSON conversion throws. */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '<unstringifiable value>'
  }
}

/**
 * Validates that `workspaces` and `sessions` form one consistent membership
 * graph: every id is a non-empty string, no id is duplicated within its own
 * collection, and every workspace id a session names is actually present in
 * `workspaces`. Anything else throws MalformedMembershipError rather than
 * letting the caller reason about a graph that does not actually cohere —
 * failing open here (e.g. silently ignoring a dangling reference) is exactly
 * the kind of mistake that could let two workspaces conduct one session.
 */
function assertValidMembershipGraph(
  workspaces: readonly MembershipWorkspace[],
  sessions: readonly MembershipSession[]
): void {
  const workspaceIds = new Set<string>()
  for (const workspace of workspaces) {
    if (typeof workspace.id !== 'string' || workspace.id === '') {
      throw new MalformedMembershipError(
        `workspace has an empty or non-string id: ${describeValue(workspace)}`
      )
    }
    if (workspaceIds.has(workspace.id)) {
      throw new MalformedMembershipError(`duplicate workspace id: ${describeValue(workspace.id)}`)
    }
    workspaceIds.add(workspace.id)
  }

  const sessionIds = new Set<string>()
  for (const session of sessions) {
    if (typeof session.id !== 'string' || session.id === '') {
      throw new MalformedMembershipError(`session has an empty or non-string id: ${describeValue(session)}`)
    }
    if (sessionIds.has(session.id)) {
      throw new MalformedMembershipError(`duplicate session id: ${describeValue(session.id)}`)
    }
    sessionIds.add(session.id)

    for (const workspaceId of session.workspaceIds ?? []) {
      if (!workspaceIds.has(workspaceId)) {
        throw new MalformedMembershipError(
          `session ${describeValue(session.id)} references unknown workspace ${describeValue(workspaceId)}`
        )
      }
    }
  }
}

function conductedById(
  workspaces: readonly MembershipWorkspace[]
): Map<string, MembershipWorkspace> {
  return new Map(workspaces.filter((w) => w.conducted).map((w) => [w.id, w]))
}

/** May `wsId` be conducted, given who its sessions already answer to? */
export function canConduct(
  workspaces: readonly MembershipWorkspace[],
  sessions: readonly MembershipSession[],
  wsId: string
): MembershipVerdict {
  if (!wsId) {
    throw new MalformedMembershipError('canConduct received an empty workspace id')
  }
  assertValidMembershipGraph(workspaces, sessions)

  const target = workspaces.find((w) => w.id === wsId)
  // Fail closed: an unrecognised workspace must never be treated as
  // conductable by default.
  if (!target) {
    return { ok: false, conflicts: [] }
  }

  const conducted = conductedById(workspaces)
  const conflicts: Conflict[] = []

  for (const session of sessions) {
    const memberIds = session.workspaceIds ?? []
    if (!memberIds.includes(wsId)) continue

    for (const otherId of memberIds) {
      if (otherId === wsId) continue
      const other = conducted.get(otherId)
      if (!other) continue
      conflicts.push({
        sessionId: session.id,
        sessionLabel: session.label,
        otherWorkspaceId: other.id,
        otherWorkspaceName: other.name
      })
    }
  }

  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts }
}

/**
 * The single validator every membership mutation path must go through — set,
 * add, remove, move and archive alike, not only the conducted toggle. Judges
 * the PROPOSED final membership (`nextWorkspaceIds`) on its own: a session
 * may not end up a member of more than one conducted workspace, regardless of
 * which workspaces it belonged to beforehand.
 */
export function validateMembershipChange(
  workspaces: readonly MembershipWorkspace[],
  sessions: readonly MembershipSession[],
  change: { sessionId: string; nextWorkspaceIds: string[] }
): MembershipVerdict {
  if (!change.sessionId) {
    throw new MalformedMembershipError('validateMembershipChange received an empty session id')
  }
  assertValidMembershipGraph(workspaces, sessions)

  const workspaceIds = new Set(workspaces.map((w) => w.id))
  const seenNext = new Set<string>()
  for (const id of change.nextWorkspaceIds) {
    if (!workspaceIds.has(id)) {
      throw new MalformedMembershipError(
        `validateMembershipChange received nextWorkspaceIds naming unknown workspace ${describeValue(id)}`
      )
    }
    if (seenNext.has(id)) {
      throw new MalformedMembershipError(
        `validateMembershipChange received a duplicate workspace id in nextWorkspaceIds: ${describeValue(id)}`
      )
    }
    seenNext.add(id)
  }

  const conducted = conductedById(workspaces)
  const existingSession = sessions.find((s) => s.id === change.sessionId)
  const sessionLabel = existingSession?.label ?? change.sessionId

  const conductedTargets = change.nextWorkspaceIds
    .map((id) => conducted.get(id))
    .filter((w): w is MembershipWorkspace => Boolean(w))

  // At most one conducted workspace among the proposed membership is fine;
  // anything past the first is a conflict against that first one.
  if (conductedTargets.length <= 1) {
    return { ok: true }
  }

  const [, ...rest] = conductedTargets
  const conflicts: Conflict[] = rest.map((other) => ({
    sessionId: change.sessionId,
    sessionLabel,
    otherWorkspaceId: other.id,
    otherWorkspaceName: other.name
  }))

  return { ok: false, conflicts }
}
