import type React from 'react'
import { useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { GridTile } from './GridTile'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onNew: () => void
  onReorder: (orderedIds: string[]) => void
}

export function GridView({
  roster,
  characters,
  selectedId,
  onSelect,
  onExpand,
  onNew,
  onReorder
}: Props): JSX.Element {
  // Tiles hold static positions (roster order) that the user can rearrange by
  // dragging a tile header. They never auto-reshuffle on state changes.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  function reset(): void {
    setDraggingId(null)
    setOverId(null)
  }

  function handleDrop(targetId: string): void {
    if (!draggingId || draggingId === targetId) return reset()
    const ids = roster.map((s) => s.id)
    const from = ids.indexOf(draggingId)
    const targetIdx = ids.indexOf(targetId)
    const next = ids.filter((id) => id !== draggingId)
    const insertAt = next.indexOf(targetId) + (from < targetIdx ? 1 : 0)
    next.splice(insertAt, 0, draggingId)
    onReorder(next)
    reset()
  }

  if (roster.length === 0) {
    return (
      <main className="gridview gridview--empty">
        <div className="empty">
          <div className="empty__glyph">▦</div>
          <h2>No sessions yet</h2>
          <p>Launch some agents and they'll appear here as a live dashboard.</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={onNew}>
            ＋ New Session
          </button>
        </div>
      </main>
    )
  }

  const charById = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)

  return (
    <main className="gridview">
      <div className="grid">
        {roster.map((s) => (
          <GridTile
            key={s.id}
            session={s}
            character={charById(s.characterId)}
            selected={s.id === selectedId}
            isDragging={draggingId === s.id}
            isDragOver={overId === s.id && draggingId !== s.id}
            onSelect={() => onSelect(s.id)}
            onExpand={() => onExpand(s.id)}
            onDragStart={(e: React.DragEvent) => {
              setDraggingId(s.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', s.id)
            }}
            onDragOver={(e: React.DragEvent) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overId !== s.id) setOverId(s.id)
            }}
            onDrop={(e: React.DragEvent) => {
              e.preventDefault()
              handleDrop(s.id)
            }}
            onDragEnd={reset}
          />
        ))}
      </div>
    </main>
  )
}
