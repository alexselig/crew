import type { CustomViewItem, SessionInfo } from '../shared/types'

export type OrganizerAction =
  | { type: 'insert'; session: SessionInfo; index: number }
  | { type: 'move'; sessionId: string; index: number }
  | { type: 'remove'; sessionId: string }
  | { type: 'move-up'; sessionId: string }
  | { type: 'move-down'; sessionId: string }
  | { type: 'move-first'; sessionId: string }
  | { type: 'move-last'; sessionId: string }

export function reduceOrganizer(
  draft: CustomViewItem[],
  action: OrganizerAction
): CustomViewItem[] {
  const move = (sessionId: string, index: number): CustomViewItem[] => {
    const current = draft.find((item) => item.sessionId === sessionId)
    if (!current) return draft
    const next = draft.filter((item) => item.sessionId !== sessionId)
    next.splice(Math.min(Math.max(index, 0), next.length), 0, current)
    return next
  }

  switch (action.type) {
    case 'insert': {
      const next = draft.filter((item) => item.sessionId !== action.session.id)
      const item = {
        sessionId: action.session.id,
        labelSnapshot: action.session.label
      }
      next.splice(Math.min(Math.max(action.index, 0), next.length), 0, item)
      return next
    }
    case 'move':
      return move(action.sessionId, action.index)
    case 'remove': {
      if (!draft.some((item) => item.sessionId === action.sessionId)) return draft
      return draft.filter((item) => item.sessionId !== action.sessionId)
    }
    case 'move-up': {
      const index = draft.findIndex((item) => item.sessionId === action.sessionId)
      return index <= 0 ? draft : move(action.sessionId, index - 1)
    }
    case 'move-down': {
      const index = draft.findIndex((item) => item.sessionId === action.sessionId)
      return index < 0 || index >= draft.length - 1 ? draft : move(action.sessionId, index + 1)
    }
    case 'move-first':
      return move(action.sessionId, 0)
    case 'move-last':
      return move(action.sessionId, draft.length - 1)
  }
}
