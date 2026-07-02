import type React from 'react'
import { useState } from 'react'

export interface GroupHeaderDnd {
  draggable: true
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export interface GroupReorder {
  dragging: string | null
  overName: string | null
  handlers: (name: string) => GroupHeaderDnd
}

/** Drag-to-reorder for group headers (nav + grid). `names` is the current
 * display order; on drop it computes the new order and calls onReorder, which
 * persists it. */
export function useGroupReorder(names: string[], onReorder: (names: string[]) => void): GroupReorder {
  const [dragging, setDragging] = useState<string | null>(null)
  const [overName, setOverName] = useState<string | null>(null)

  function reset(): void {
    setDragging(null)
    setOverName(null)
  }

  function drop(target: string): void {
    if (!dragging || dragging === target) return reset()
    const from = names.indexOf(dragging)
    const targetIdx = names.indexOf(target)
    if (from === -1 || targetIdx === -1) return reset()
    const next = names.filter((n) => n !== dragging)
    const insertAt = next.indexOf(target) + (from < targetIdx ? 1 : 0)
    next.splice(insertAt, 0, dragging)
    onReorder(next)
    reset()
  }

  return {
    dragging,
    overName,
    handlers: (name: string) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragging(name)
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', name)
      },
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (overName !== name) setOverName(name)
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        drop(name)
      },
      onDragEnd: reset
    })
  }
}
