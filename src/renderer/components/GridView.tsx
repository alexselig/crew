import type { SessionInfo, CharacterDef } from '../../shared/types'
import { GridTile } from './GridTile'
import { GroupPicker } from './GroupPicker'
import { groupSessions, type GroupMode } from '../grouping'
import { useGroupReorder } from '../useGroupReorder'
import { useCardDnd, mergeHeaderDnd } from '../useCardDnd'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  groupOrder: string[]
  onReorderGroups: (names: string[]) => void
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onNew: () => void
  onReorder: (orderedIds: string[]) => void
  onSetTag: (id: string, tag: string) => void
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
  groupOrder,
  onReorderGroups,
  onSelect,
  onExpand,
  onNew,
  onReorder,
  onSetTag
}: Props): JSX.Element {
  // Tiles hold static positions (roster order) that the user can rearrange by
  // dragging a tile header. They never auto-reshuffle on state changes. In tag
  // grouping, dragging a tile onto another group (or its header) retags it;
  // 'needs' groups are state-derived, so tile dragging is off there.
  const grouped = groupMode !== 'none'
  const groups = grouped ? groupSessions(roster, groupMode, groupOrder) : []
  const gdnd = useGroupReorder(
    groups.map((g) => g.name),
    onReorderGroups
  )
  const dnd = useCardDnd(roster, groupMode, onReorder, onSetTag)

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

  function renderTile(s: SessionInfo): JSX.Element {
    const h = dnd.cardHandlers(s)
    return (
      <GridTile
        key={s.id}
        session={s}
        character={charById(s.characterId)}
        selected={s.id === selectedId}
        isDragging={dnd.draggingId === s.id}
        isDragOver={dnd.overId === s.id && dnd.draggingId !== s.id}
        onSelect={() => onSelect(s.id)}
        onExpand={() => onExpand(s.id)}
        onDragStart={h?.onDragStart}
        onDragOver={h?.onDragOver}
        onDrop={h?.onDrop}
        onDragEnd={h?.onDragEnd}
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
                className={`grid-group__header ${g.kind === 'needs' ? 'grid-group__header--needs' : ''} ${gdnd.dragging === g.name ? 'is-dragging' : ''} ${(gdnd.overName === g.name && gdnd.dragging !== g.name) || dnd.overGroup === g.name ? 'is-drag-over' : ''}`}
                onClick={() => onToggleGroup(g.name)}
                title={groupMode === 'tag' ? 'Drag to reorder groups · drop a session here to move it' : 'Drag to reorder groups'}
                {...mergeHeaderDnd(gdnd.handlers(g.name), dnd, g.name)}
              >
                <span className="group__chevron">{collapsedGroups.has(g.name) ? '▸' : '▾'}</span>
                <span className="grid-group__name">{g.name}</span>
                <span className="group__count">{g.items.length}</span>
              </button>
              {!collapsedGroups.has(g.name) && (
                <div className="grid">{g.items.map(renderTile)}</div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="grid">{roster.map(renderTile)}</div>
      )}
    </main>
  )
}
