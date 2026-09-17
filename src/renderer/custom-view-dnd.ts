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
  const moveToIndex = (sessionId: string, index: number): CustomViewItem[] => {
    const current = draft.find((item) => item.sessionId === sessionId)
    if (!current) return draft
    const next = draft.filter((item) => item.sessionId !== sessionId)
    next.splice(Math.min(Math.max(index, 0), next.length), 0, current)
    return next
  }
  const moveToSlot = (sessionId: string, index: number): CustomViewItem[] => {
    const sourceIndex = draft.findIndex((item) => item.sessionId === sessionId)
    if (sourceIndex < 0) return draft
    return moveToIndex(sessionId, sourceIndex < index ? index - 1 : index)
  }

  switch (action.type) {
    case 'insert': {
      const sourceIndex = draft.findIndex((item) => item.sessionId === action.session.id)
      const next = draft.filter((item) => item.sessionId !== action.session.id)
      const item = {
        sessionId: action.session.id,
        labelSnapshot: action.session.label
      }
      const index = sourceIndex >= 0 && sourceIndex < action.index ? action.index - 1 : action.index
      next.splice(Math.min(Math.max(index, 0), next.length), 0, item)
      return next
    }
    case 'move':
      return moveToSlot(action.sessionId, action.index)
    case 'remove': {
      if (!draft.some((item) => item.sessionId === action.sessionId)) return draft
      return draft.filter((item) => item.sessionId !== action.sessionId)
    }
    case 'move-up': {
      const index = draft.findIndex((item) => item.sessionId === action.sessionId)
      return index <= 0 ? draft : moveToIndex(action.sessionId, index - 1)
    }
    case 'move-down': {
      const index = draft.findIndex((item) => item.sessionId === action.sessionId)
      return index < 0 || index >= draft.length - 1
        ? draft
        : moveToIndex(action.sessionId, index + 1)
    }
    case 'move-first':
      return moveToIndex(action.sessionId, 0)
    case 'move-last':
      return moveToIndex(action.sessionId, draft.length - 1)
  }
}
