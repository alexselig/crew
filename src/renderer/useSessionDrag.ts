import type React from 'react'
import { useState } from 'react'

/** copy = add to target (keep source); move = remove from source, add to target. */
export type DropIntent = 'copy' | 'move'

interface Payload {
  sessionIds: string[]
  fromLaneId: string | null
}

const MIME = 'application/x-crew-session'

export interface SessionDrag {
  /** Ids currently being dragged (one for a card, many for a group); empty when idle. */
  draggingIds: string[]
  /** The lane currently hovered while dragging: a workspace id, `null` for the
   *  Archived lane, or `undefined` when nothing is hovered. */
  overLane: string | null | undefined
  /** Drag handlers for a single session card. */
  cardHandlers: (sessionId: string, laneId: string | null) => {
    draggable: true
    onDragStart: (e: React.DragEvent) => void
    onDragEnd: () => void
  }
  /** Drag handlers for an in-lane group header (carries every session in it). */
  groupHandlers: (sessionIds: string[], laneId: string | null) => {
    draggable: true
    onDragStart: (e: React.DragEvent) => void
    onDragEnd: () => void
  }
  laneHandlers: (laneId: string | null) => {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: () => void
    onDrop: (e: React.DragEvent) => void
  }
}

/**
 * Native HTML5 drag for the Workspace board. A card carries its own session id;
 * an in-lane group header carries every session id in that group — so you can
 * drag one session or a whole group into another workspace. A lane is a drop
 * target. The drop intent is `copy` by default and `move` when ⌘/Alt is held.
 * Lane id `null` represents the Archived lane. Sibling to `useGroupReorder`
 * (which reorders lane *headers*).
 */
export function useSessionDrag(
  onDrop: (sessionIds: string[], fromLaneId: string | null, toLaneId: string | null, intent: DropIntent) => void
): SessionDrag {
  const [draggingIds, setDraggingIds] = useState<string[]>([])
  // `undefined` = not hovering any lane; `null` = hovering the Archived lane;
  // a string = hovering that workspace lane. Keeping "none" distinct from the
  // Archived lane's `null` id stops Archived from always looking like a target.
  const [overLane, setOverLane] = useState<string | null | undefined>(undefined)

  const reset = (): void => {
    setDraggingIds([])
    setOverLane(undefined)
  }
  const intentFrom = (e: React.DragEvent): DropIntent => (e.altKey || e.metaKey ? 'move' : 'copy')

  const startDrag = (ids: string[], laneId: string | null, e: React.DragEvent): void => {
    setDraggingIds(ids)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData(MIME, JSON.stringify({ sessionIds: ids, fromLaneId: laneId } as Payload))
  }

  return {
    draggingIds,
    overLane,
    cardHandlers: (sessionId, laneId) => ({
      draggable: true,
      onDragStart: (e) => startDrag([sessionId], laneId, e),
      onDragEnd: reset
    }),
    groupHandlers: (sessionIds, laneId) => ({
      draggable: true,
      onDragStart: (e) => startDrag(sessionIds, laneId, e),
      onDragEnd: reset
    }),
    laneHandlers: (laneId) => ({
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = intentFrom(e)
        if (overLane !== laneId) setOverLane(laneId)
      },
      onDragLeave: () => setOverLane((cur) => (cur === laneId ? undefined : cur)),
      onDrop: (e) => {
        e.preventDefault()
        const raw = e.dataTransfer.getData(MIME)
        const intent = intentFrom(e)
        reset()
        if (!raw) return
        const { sessionIds, fromLaneId } = JSON.parse(raw) as Payload
        if (fromLaneId === laneId) return
        onDrop(sessionIds, fromLaneId, laneId, intent)
      }
    })
  }
}
