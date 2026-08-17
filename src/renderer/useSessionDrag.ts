import type React from 'react'
import { useState } from 'react'

/** copy = add to target (keep source); move = remove from source, add to target. */
export type DropIntent = 'copy' | 'move'

interface Payload {
  sessionId: string
  fromLaneId: string | null
}

const MIME = 'application/x-crew-session'

export interface SessionDrag {
  dragging: string | null
  overLane: string | null
  cardHandlers: (sessionId: string, laneId: string | null) => {
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
 * Native HTML5 drag for session cards on the Workspace board. A card carries its
 * session id + source lane; a lane is a drop target. The drop intent is `copy`
 * by default and `move` when the pointer holds ⌘/Alt — so dragging a session
 * into a workspace adds it (non-destructively) unless the user asks to move it.
 * Lane id `null` represents the Archived lane. Sibling to `useGroupReorder`
 * (which reorders lane *headers*).
 */
export function useSessionDrag(
  onDrop: (sessionId: string, fromLaneId: string | null, toLaneId: string | null, intent: DropIntent) => void
): SessionDrag {
  const [dragging, setDragging] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)

  const reset = (): void => {
    setDragging(null)
    setOverLane(null)
  }
  const intentFrom = (e: React.DragEvent): DropIntent => (e.altKey || e.metaKey ? 'move' : 'copy')

  return {
    dragging,
    overLane,
    cardHandlers: (sessionId, laneId) => ({
      draggable: true,
      onDragStart: (e) => {
        setDragging(sessionId)
        e.dataTransfer.effectAllowed = 'copyMove'
        e.dataTransfer.setData(MIME, JSON.stringify({ sessionId, fromLaneId: laneId } as Payload))
      },
      onDragEnd: reset
    }),
    laneHandlers: (laneId) => ({
      onDragOver: (e) => {
        if (!e.dataTransfer.types.includes(MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = intentFrom(e)
        if (overLane !== laneId) setOverLane(laneId)
      },
      onDragLeave: () => setOverLane((cur) => (cur === laneId ? null : cur)),
      onDrop: (e) => {
        e.preventDefault()
        const raw = e.dataTransfer.getData(MIME)
        const intent = intentFrom(e)
        reset()
        if (!raw) return
        const { sessionId, fromLaneId } = JSON.parse(raw) as Payload
        if (fromLaneId === laneId) return
        onDrop(sessionId, fromLaneId, laneId, intent)
      }
    })
  }
}
