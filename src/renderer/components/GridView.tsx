import { useEffect } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { GridTile } from './GridTile'
import { GroupPicker } from './GroupPicker'
import { Icon } from './Icon'
import { ResumeSets } from './ResumeSets'
import { formatUsd, formatCredits } from '../state-meta'
import { groupSessions, existingGroups, type GroupMode } from '../grouping'
import { useGroupReorder } from '../useGroupReorder'
import { useCardDnd, mergeHeaderDnd } from '../useCardDnd'
import type { ViewMode, GridDensity } from '../hooks'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  gridDensity: GridDensity
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  groupOrder: string[]
  onReorderGroups: (names: string[]) => void
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReplayIntro?: () => void
  onSetViewMode: (m: ViewMode) => void
  onOpenSettings: () => void
  onBroadcast: () => void
  onAnalytics: () => void
  showSpend: boolean
  showCredits: boolean
  onReorder: (orderedIds: string[]) => void
  onSetTag: (id: string, tag: string) => void
  onSetCharacter: (id: string, characterId: string) => void
  onSetColor: (id: string, color: string) => void
}

export function GridView({
  roster,
  characters,
  selectedId,
  gridDensity,
  groupMode,
  onSetGroupMode,
  collapsedGroups,
  onToggleGroup,
  groupOrder,
  onReorderGroups,
  onSelect,
  onExpand,
  onClose,
  onNew,
  onReplayIntro,
  onOpenSettings,
  onBroadcast,
  onAnalytics,
  showSpend,
  showCredits,
  onReorder,
  onSetTag,
  onSetCharacter,
  onSetColor
}: Props): JSX.Element {
  // Tiles hold static positions (roster order) that the user can rearrange by
  // dragging a tile header. They never auto-reshuffle on state changes. In tag
  // grouping, dragging a tile onto another group (or its header) retags it;
  // 'needs' groups are state-derived, so tile dragging is off there.
  const grouped = groupMode !== 'none'
  // Density layouts apply to the flat grid only; grouped view keeps default tiles.
  const density = grouped ? null : gridDensity
  const groups = grouped ? groupSessions(roster, groupMode, groupOrder) : []
  const gdnd = useGroupReorder(
    groups.map((g) => g.name),
    onReorderGroups
  )
  const dnd = useCardDnd(roster, groupMode, onReorder, onSetTag)
  const tagGroups = existingGroups(roster)

  // Clicking a session in the nav selects it — scroll its tile into view so the
  // picked session is visible in the grid.
  useEffect(() => {
    if (!selectedId) return
    const el = document.querySelector(`.tile[data-session-id="${CSS.escape(selectedId)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedId])

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
          <ResumeSets />
        </div>
      </main>
    )
  }

  const charById = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)
  const activeCharacterIds = roster.filter((s) => s.status === 'active').map((s) => s.characterId)
  const waiting = roster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state)).length
  const totalUsd = roster.reduce((sum, s) => sum + (s.costUsd || 0), 0)
  const totalCredits = roster.reduce((sum, s) => sum + (s.creditsUsed || 0), 0)

  function renderTile(s: SessionInfo): JSX.Element {
    const h = dnd.cardHandlers(s)
    return (
      <GridTile
        key={s.id}
        session={s}
        character={charById(s.characterId)}
        characters={characters}
        usedCharacterIds={activeCharacterIds}
        selected={s.id === selectedId}
        isDragging={dnd.draggingId === s.id}
        isDragOver={dnd.overId === s.id && dnd.draggingId !== s.id}
        groups={tagGroups}
        onSelect={() => onSelect(s.id)}
        onExpand={() => onExpand(s.id)}
        onClose={() => onClose(s.id)}
        onSetCharacter={(cid) => onSetCharacter(s.id, cid)}
        onSetColor={(col) => onSetColor(s.id, col)}
        onSetTag={(t) => onSetTag(s.id, t)}
        onDragStart={h?.onDragStart}
        onDragOver={h?.onDragOver}
        onDrop={h?.onDrop}
        onDragEnd={h?.onDragEnd}
      />
    )
  }

  return (
    <main className={`gridview ${density ? `gridview--${density}` : ''}`}>
      <div className="grid-topbar">
        <div className="grid-topbar__left">
          <button
            type="button"
            className="grid-topbar__wordmark"
            title="Replay intro"
            onClick={onReplayIntro}
          >
            Crew
          </button>
          <span className="grid-topbar__sub">All sessions · {roster.length}</span>
        </div>
        <div className="grid-topbar__right">
          <div className="grid-topbar__tools">
            <GroupPicker mode={groupMode} onChoose={onSetGroupMode} />
            <button type="button" className="icon-btn" title="Broadcast a prompt" onClick={onBroadcast}>
              <Icon name="broadcast" />
            </button>
            <button type="button" className="icon-btn" title="Activity & spend" onClick={onAnalytics}>
              <Icon name="chart" />
            </button>
            <button type="button" className="icon-btn" title="Settings" onClick={onOpenSettings}>
              <Icon name="settings" />
            </button>
          </div>
        </div>
      </div>

      <div className="gridview__scroll">
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
          <div className={`grid ${density ? `grid--${density}` : ''}`}>{roster.map(renderTile)}</div>
        )}
      </div>

      {(showSpend || showCredits) && (
        <div className="grid-footer">
          <span className="grid-footer__note">
            {waiting > 0
              ? `${waiting} waiting for you`
              : `${roster.length} ${roster.length === 1 ? 'session' : 'sessions'}`}
          </span>
          <span className="grid-footer__total">
            TOTAL{' '}
            {showSpend && <span>{formatUsd(totalUsd)}</span>}
            {showSpend && showCredits && <span className="dot-sep"> · </span>}
            {showCredits && <span>{formatCredits(totalCredits)} cr</span>}
          </span>
        </div>
      )}
    </main>
  )
}
