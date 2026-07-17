import { useEffect, useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { GridTile } from './GridTile'
import { GroupPicker } from './GroupPicker'
import { Icon } from './Icon'
import { ResumeSets } from './ResumeSets'
import { groupSessions, existingGroups, partitionHidden, recencyOf, type GroupMode } from '../grouping'
import { useCardDnd } from '../useCardDnd'
import { useNowTick } from '../hooks'
import type { ViewMode, GridDensity } from '../hooks'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  selectedId: string | null
  gridDensity: GridDensity
  /** Active workspace filter name (null = All), shown in the top bar. */
  activeWorkspace?: string | null
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  /** Minimized session ids (hidden behind a per-group "show more"). */
  minimized: Set<string>
  onToggleMinimize: (id: string) => void
  /** Hours after which an unused session is hidden in group (tag) sort (0 = off). */
  staleHideHours: number
  groupOrder: string[]
  onReorderGroups: (names: string[]) => void
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onReplayIntro?: () => void
  onSetViewMode: (m: ViewMode) => void
  /** Cycle grid density (2 → 4 → 6), driven by the grid button in the top bar. */
  onGridRepeat: () => void
  onOpenSettings: () => void
  onBroadcast: () => void
  onAnalytics: () => void
  showSpend: boolean
  showCredits: boolean
  onReorder: (orderedIds: string[]) => void
  onSetTag: (id: string, tag: string) => void
  /** All known group names (from the full roster) offered by the per-session group picker. */
  allGroups?: string[]
  onSetCharacter: (id: string, characterId: string) => void
  onSetColor: (id: string, color: string) => void
}

export function GridView({
  roster,
  characters,
  selectedId,
  gridDensity,
  activeWorkspace,
  groupMode,
  onSetGroupMode,
  minimized,
  onToggleMinimize,
  staleHideHours,
  groupOrder,
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
  allGroups,
  onSetCharacter,
  onSetColor
}: Props): JSX.Element {
  // Tiles hold static positions (roster order) the user can rearrange by dragging.
  const grouped = groupMode !== 'none'
  useNowTick(grouped && groupMode === 'recent')
  // Per-bucket "show more" reveal state (bucket name, or '__all__' when ungrouped).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
  const toggleExpand = (key: string): void =>
    setExpandedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const staleCutoff = Date.now() - staleHideHours * 60 * 60 * 1000
  const isHidden = (s: SessionInfo): boolean =>
    minimized.has(s.id) ||
    (groupMode === 'tag' && staleHideHours > 0 && recencyOf(s) < staleCutoff)
  // `density` sets the flat grid's density class on <main> + the grid. Grouped view
  // scrolls horizontally instead (each group is a column-major band via
  // `grid--g-${gridDensity}`), so it leaves <main> without the density class.
  const density = grouped ? null : gridDensity
  const groups = grouped ? groupSessions(roster, groupMode, groupOrder) : []
  const dnd = useCardDnd(roster, groupMode, onReorder, onSetTag)
  const tagGroups = allGroups ?? existingGroups(roster)

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
          {activeWorkspace ? (
            <>
              <h2>No sessions in “{activeWorkspace}”</h2>
              <p>This workspace has no sessions yet. Add one, or switch back to all sessions.</p>
            </>
          ) : (
            <>
              <h2>No sessions yet</h2>
              <p>Launch some agents and they'll appear here as a live dashboard.</p>
            </>
          )}
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
        onMinimize={() => onToggleMinimize(s.id)}
        minimized={minimized.has(s.id)}
        onSetCharacter={onSetCharacter}
        onSetColor={onSetColor}
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
          <span className="grid-topbar__sub">
            {activeWorkspace ? `▚ ${activeWorkspace}` : 'All sessions'} · {roster.length}
          </span>
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
            <button
              type="button"
              className="icon-btn"
              title="New window (⇧⌘N)"
              onClick={() => void window.crew.openWindow()}
            >
              <Icon name="windows" />
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
            {groups.map((g) => {
              const { visible, hidden } = partitionHidden(g.items, isHidden)
              const open = expandedGroups.has(g.name)
              return (
                <section className="grid-group" key={g.name}>
                  <div className={`grid grid--grouped grid--g-${gridDensity}`}>
                    {visible.map(renderTile)}
                    {open && hidden.map(renderTile)}
                    {hidden.length > 0 && (
                      <button
                        type="button"
                        className="grid-showmore"
                        onClick={() => toggleExpand(g.name)}
                      >
                        <span className="grid-showmore__name">{g.name}</span>
                        <span className="grid-showmore__more">
                          {open ? 'Show less' : `Show ${hidden.length} more`}
                        </span>
                      </button>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        ) : (
          (() => {
            const { visible, hidden } = partitionHidden(roster, isHidden)
            const open = expandedGroups.has('__all__')
            return (
              <div className={`grid ${density ? `grid--${density}` : ''}`}>
                {visible.map(renderTile)}
                {open && hidden.map(renderTile)}
                {hidden.length > 0 && (
                  <button
                    type="button"
                    className="grid-showmore"
                    onClick={() => toggleExpand('__all__')}
                  >
                    <span className="grid-showmore__more">
                      {open ? 'Show less' : `Show ${hidden.length} more`}
                    </span>
                  </button>
                )}
              </div>
            )
          })()
        )}
      </div>
    </main>
  )
}
