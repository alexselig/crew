import { sessionInWorkspaceId } from './workspaces'

/**
 * Which session should be selected, given the roster, the current selection and
 * any workspace filter.
 *
 * Selection has exactly one rule — it is always a session the user can actually
 * see — and this is the only place that decides it. That matters more than it
 * looks: when the rule was split in two, one half re-selected from the whole
 * roster whenever nothing was selected, while the other half cleared any
 * selection hidden by the workspace filter. With a workspace that contained no
 * sessions, neither could ever be satisfied, so they overwrote each other as
 * fast as the app could re-render — pinning the window, and eventually
 * exhausting its memory and restarting it.
 *
 * Returning the current selection unchanged whenever it is still visible is what
 * makes this settle: applying the result can never produce a different result.
 */
export function nextSelection(
  roster: readonly { id: string; workspaceIds?: readonly string[] }[],
  selectedId: string | null,
  activeWorkspace: string | null
): string | null {
  const visible = roster.filter((s) => sessionInWorkspaceId(s.workspaceIds, activeWorkspace))
  if (selectedId && visible.some((s) => s.id === selectedId)) return selectedId
  return visible[0]?.id ?? null
}
