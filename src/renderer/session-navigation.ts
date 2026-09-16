import type { CustomView, SessionInfo, SessionPresentation } from '../shared/types'
import { sessionInWorkspaceId } from '../shared/workspaces'

interface SessionNavigationState {
  id: string
  roster: readonly SessionInfo[]
  activeWorkspace: string | null
  presentation: SessionPresentation
  customViews: readonly CustomView[]
}

interface SessionNavigationActions {
  setActiveWorkspace: (id: string | null) => void
  setPresentation: (presentation: SessionPresentation) => void
  selectSession: (id: string) => void
  setShowNew: (show: boolean) => void
}

const RECENT_PRESENTATION: SessionPresentation = { kind: 'builtin', mode: 'recent' }

export function navigateToSession(
  state: SessionNavigationState,
  actions: SessionNavigationActions
): boolean {
  const target = state.roster.find((session) => session.id === state.id)
  if (!target) return false

  if (!sessionInWorkspaceId(target.workspaceIds, state.activeWorkspace)) {
    actions.setActiveWorkspace(null)
  }

  const presentation = state.presentation
  if (presentation.kind === 'custom') {
    const view = state.customViews.find((item) => item.id === presentation.viewId)
    if (
      !view ||
      (view.mode === 'curated-only' &&
        !view.items.some((item) => item.sessionId === target.id))
    ) {
      actions.setPresentation(RECENT_PRESENTATION)
    }
  }

  actions.selectSession(target.id)
  actions.setShowNew(false)
  return true
}
