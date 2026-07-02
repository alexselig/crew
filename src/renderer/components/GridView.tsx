import type React from 'react'
import { useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { GridTile } from './GridTile'
import { GroupPicker } from './GroupPicker'
import { groupSessions, type GroupMode } from '../grouping'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onNew: () => void
  onReorder: (orderedIds: string[]) => void
}

const MODE_LABEL: Record<GroupMode, string> = {
  none: 'All sessions',
  needs: 'Grouped by attention',
  tag: 'Grouped by group'
}

export function GridView({
  roster,
  characters,
  selectedId,
  groupMode,
  onSetGroupMode,
  collapsedGroups,
  onToggleGroup,
  onSelect,
  onExpand,
  onNew,
  onReorder
}: Props): JSX.Element {
  // Tiles hold static positions (roster order) that the user can rearrange by
  // dragging a tile header. They never auto-reshuffle on state changes. Dragging
  // is only enabled in the ungrouped view.
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
  const grouped = groupMode !== 'none'
  const groups = grouped ? groupSessions(roster, groupMode) : []

  function renderTile(s: SessionInfo, dnd: boolean): JSX.Element {
    return (
      <GridTile
        key={s.id}
        session={s}
        character={charById(s.characterId)}
        selected={s.id === selectedId}
        isDragging={dnd && draggingId === s.id}
        isDragOver={dnd && overId === s.id && draggingId !== s.id}
        onSelect={() => onSelect(s.id)}
        onExpand={() => onExpand(s.id)}
        onDragStart={
          dnd
            ? (e: React.DragEvent) => {
                setDraggingId(s.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.id)
              }
            : undefined
        }
        onDragOver={
          dnd
            ? (e: React.DragEvent) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== s.id) setOverId(s.id)
              }
            : undefined
        }
        onDrop={
          dnd
            ? (e: React.DragEvent) => {
                e.preventDefault()
                handleDrop(s.id)
              }
            : undefined
        }
        onDragEnd={dnd ? reset : undefined}
      />
    )
  }

  return (
    <main className="gridview">
      <div className="grid-toolbar">
        <span className="grid-toolbar__label">{MODE_LABEL[groupMode]}</span>
        <GroupPicker mode={groupMode} onChoose={onSetGroupMode} />
      </div>
      {grouped ? (
        <div className="grid-groups">
          {groups.map((g) => (
            <section className="grid-group" key={g.name}>
              <button
                type="button"
                className={`grid-group__header ${g.kind === 'needs' ? 'grid-group__header--needs' : ''}`}
                onClick={() => onToggleGroup(g.name)}
              >
                <span className="group__chevron">{collapsedGroups.has(g.name) ? '▸' : '▾'}</span>
                <span className="grid-group__name">{g.name}</span>
                <span className="group__count">{g.items.length}</span>
              </button>
              {!collapsedGroups.has(g.name) && (
                <div className="grid">{g.items.map((s) => renderTile(s, false))}</div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid">{roster.map((s) => renderTile(s, true))}</div>
      )}
    </main>
  )
}
