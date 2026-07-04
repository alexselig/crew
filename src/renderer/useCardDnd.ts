import type React from 'react'
import { useState } from 'react'
import type { SessionInfo } from '../shared/types'
import type { GroupMode } from './grouping'
import type { GroupHeaderDnd } from './useGroupReorder'

/** Display name of the no-tag bucket in 'tag' grouping (see grouping.ts). */
export const UNGROUPED = 'Ungrouped'

export interface CardDndHandlers {
  draggable: true
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export interface CardDnd {
  draggingId: string | null
  overId: string | null
  /** Group header currently hovered by a card drag (for is-drag-over styling). */
  overGroup: string | null
  /** Card-level handlers; null when card dragging is off in this mode. */
  cardHandlers: (s: SessionInfo) => CardDndHandlers | null
  /** Retag the dragged card onto a whole group (header drop). */
  dropOnHeader: (groupName: string) => void
  setOverGroup: (name: string | null) => void
}

/** Remove `dragId` and re-insert it next to `targetId`, preserving direction. */
function moveNextTo(ids: string[], dragId: string, targetId: string): string[] {
  const from = ids.indexOf(dragId)
  const targetIdx = ids.indexOf(targetId)
  if (from === -1 || targetIdx === -1) return ids
  const next = ids.filter((id) => id !== dragId)
  const insertAt = next.indexOf(targetId) + (from < targetIdx ? 1 : 0)
  next.splice(insertAt, 0, dragId)
  return next
}

/**
 * Card drag-and-drop shared by the nav roster and the grid.
 *
 * - mode 'none':  drag to reorder.
 * - mode 'tag':   drag to reorder AND retag — dropping on a card in another
 *                 group (or on a group header) moves the session to that group.
 * - mode 'needs': off (groups are state-derived; a drop can't change state).
 * - disabled:     off (e.g. collapsed sidebar).
 */
export function useCardDnd(
  roster: SessionInfo[],
  mode: GroupMode | 'disabled',
  onReorder: (ids: string[]) => void,
  onSetTag: (id: string, tag: string) => void
): CardDnd {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [overGroup, setOverGroup] = useState<string | null>(null)
  const enabled = mode === 'none' || mode === 'tag'

  function reset(): void {
    setDraggingId(null)
    setOverId(null)
    setOverGroup(null)
  }

  function dropOnCard(target: SessionInfo): void {
    if (!draggingId || draggingId === target.id) return reset()
    if (mode === 'tag') {
      const dragged = roster.find((s) => s.id === draggingId)
      const targetTag = (target.tag ?? '').trim()
      if (dragged && (dragged.tag ?? '').trim() !== targetTag) onSetTag(draggingId, targetTag)
    }
    onReorder(moveNextTo(roster.map((s) => s.id), draggingId, target.id))
    reset()
  }

  function dropOnHeader(groupName: string): void {
    if (!draggingId || mode !== 'tag') return reset()
    const tag = groupName === UNGROUPED ? '' : groupName
    const dragged = roster.find((s) => s.id === draggingId)
    if (dragged && (dragged.tag ?? '').trim() !== tag) onSetTag(draggingId, tag)
    reset()
  }

  function cardHandlers(s: SessionInfo): CardDndHandlers | null {
    if (!enabled) return null
    return {
      draggable: true,
      onDragStart: (e) => {
        setDraggingId(s.id)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', s.id)
      },
      onDragOver: (e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (overId !== s.id) setOverId(s.id)
      },
      onDrop: (e) => {
        e.preventDefault()
        dropOnCard(s)
      },
      onDragEnd: reset
    }
  }

  return { draggingId, overId, overGroup, cardHandlers, dropOnHeader, setOverGroup }
}

/**
 * Compose group-header handlers: a card drag retags onto the group; anything
 * else falls through to the header's own drag-to-reorder behavior.
 */
export function mergeHeaderDnd(
  gh: GroupHeaderDnd,
  cd: CardDnd,
  groupName: string
): GroupHeaderDnd & { onDragLeave: () => void } {
  return {
    ...gh,
    onDragOver: (e) => {
      if (cd.draggingId) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (cd.overGroup !== groupName) cd.setOverGroup(groupName)
      } else {
        gh.onDragOver(e)
      }
    },
    onDrop: (e) => {
      if (cd.draggingId) {
        e.preventDefault()
        cd.dropOnHeader(groupName)
      } else {
        gh.onDrop(e)
      }
    },
    onDragLeave: () => {
      if (cd.overGroup === groupName) cd.setOverGroup(null)
    }
  }
}
