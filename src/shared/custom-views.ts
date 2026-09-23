import type { CustomView, CustomViewItem, SessionInfo, Workspace } from './types'

const recentActivityOf = (session: SessionInfo): number => session.lastPromptAt ?? session.createdAt

const clampIndex = (index: number, length: number): number => Math.min(Math.max(index, 0), length)

export function composeCustomView(
  roster: SessionInfo[],
  view: CustomView
): { sessions: SessionInfo[]; missing: CustomViewItem[] } {
  const byId = new Map(roster.map((session) => [session.id, session] as const))
  const sessions: SessionInfo[] = []
  const missing: CustomViewItem[] = []
  const ranked = new Set<string>()

  for (const item of view.items) {
    const session = byId.get(item.sessionId)
    if (!session) {
      missing.push(item)
      continue
    }
    if (ranked.has(session.id)) continue
    ranked.add(session.id)
    sessions.push(session)
  }

  if (view.mode === 'ranked-plus-all') {
    const rest = roster
      .map((session, index) => ({ session, index }))
      .filter(({ session }) => !ranked.has(session.id))
      .sort((a, b) => {
        const delta = recentActivityOf(b.session) - recentActivityOf(a.session)
        return delta !== 0 ? delta : a.index - b.index
      })
      .map(({ session }) => session)
    sessions.push(...rest)
  }

  return { sessions, missing }
}

export function moveIntoView(ids: string[], sessionId: string, index: number): string[] {
  const next = ids.filter((id) => id !== sessionId)
  next.splice(clampIndex(index, next.length), 0, sessionId)
  return next
}

export function moveWithinView(ids: string[], sessionId: string, index: number): string[] {
  if (!ids.includes(sessionId)) return [...ids]
  return moveIntoView(ids, sessionId, index)
}

export function removeFromView(ids: string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId)
}

/**
 * Map a nav drag-and-drop onto a view's ranked item order: drop `dragId` onto
 * `targetId`'s slot, preserving direction (dragging downward lands after the
 * target, upward lands before it) to match the roster's own reorder feel.
 *
 * Two cases are specific to 'ranked-plus-all', where the nav also shows
 * sessions the view has not ranked:
 * - dragging an unranked session onto a ranked one *pins* it at that slot;
 * - dropping onto an unranked session appends to the end of the ranked block,
 *   since there is no ranked slot to aim at.
 *
 * Returns the original array when nothing would change, so callers can skip a
 * pointless write.
 */
export function reorderViewItems(
  items: readonly CustomViewItem[],
  dragId: string,
  targetId: string,
  labelFor: (sessionId: string) => string
): CustomViewItem[] {
  if (dragId === targetId) return [...items]
  const ids = items.map((item) => item.sessionId)
  const targetIndex = ids.indexOf(targetId)
  const next = moveIntoView(ids, dragId, targetIndex === -1 ? ids.length : targetIndex)
  if (next.length === ids.length && next.every((id, i) => id === ids[i])) return [...items]
  const bySession = new Map(items.map((item) => [item.sessionId, item] as const))
  return next.map(
    (id) => bySession.get(id) ?? { sessionId: id, labelSnapshot: labelFor(id) }
  )
}

export function searchCustomViewSessions(input: {
  sessions: SessionInfo[]
  query: string
  workspaces: Workspace[]
  presetNames: ReadonlyMap<string | null, string>
  workspaceId?: string
  status?: SessionInfo['status'] | 'all'
  presetId?: string | null | 'all'
}): SessionInfo[] {
  const query = input.query.trim().toLocaleLowerCase()
  const workspaceById = new Map(input.workspaces.map((workspace) => [workspace.id, workspace] as const))

  const matchesWorkspace = (session: SessionInfo): boolean => {
    if (input.workspaceId == null) return true
    return (session.workspaceIds ?? []).includes(input.workspaceId)
  }

  const matchesStatus = (session: SessionInfo): boolean =>
    input.status == null || input.status === 'all' ? true : session.status === input.status

  const matchesPreset = (session: SessionInfo): boolean =>
    input.presetId === undefined || input.presetId === 'all' ? true : session.presetId === input.presetId

  const haystackFor = (session: SessionInfo): string => {
    const workspaceNames = (session.workspaceIds ?? [])
      .map((workspaceId) => workspaceById.get(workspaceId)?.name)
      .filter((name): name is string => !!name)
    const presetName = input.presetNames.get(session.presetId) ?? ''
    return [session.label, session.cwd, session.tag ?? '', ...workspaceNames, presetName].join(' ').toLocaleLowerCase()
  }

  return input.sessions.filter((session) => {
    if (!matchesWorkspace(session)) return false
    if (!matchesStatus(session)) return false
    if (!matchesPreset(session)) return false
    if (!query) return true
    return haystackFor(session).includes(query)
  })
}
