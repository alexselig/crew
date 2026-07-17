import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'
import { formatUsd, formatCredits } from '../state-meta'
import { SessionCard } from './SessionCard'
import { GroupPicker } from './GroupPicker'
import { Icon } from './Icon'
import { ViewToggle } from './ViewToggle'
import { groupSessions, partitionHidden, recencyOf, type GroupMode } from '../grouping'
import { useGroupReorder } from '../useGroupReorder'
import { useCardDnd, mergeHeaderDnd } from '../useCardDnd'
import { useNowTick } from '../hooks'
import type { ViewMode, GridDensity } from '../hooks'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  presets: Preset[]
  selectedId: string | null
  viewMode: ViewMode
  onSetViewMode: (m: ViewMode) => void
  onGridRepeat: () => void
  gridDensity: GridDensity
  collapsed: boolean
  hoverExpand?: boolean
  onSetCollapsed: (v: boolean) => void
  navWidth: number
  onNavWidth: (w: number) => void
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  /** Minimized session ids (hidden behind a per-bucket "show more"). */
  minimized: Set<string>
  onToggleMinimize: (id: string) => void
  groupOrder: string[]
  onReorderGroups: (names: string[]) => void
  onSelect: (id: string) => void
  onNew: () => void
  onReplayIntro?: () => void
  onOpenSettings: () => void
  onBroadcast: () => void
  onAnalytics: () => void
  showSpend: boolean
  showCredits: boolean
  budgetUsd: number
  /** Hours after which an unused session is hidden behind a per-group "show
   * more" in group (tag) sort. 0 = never hide. */
  staleHideHours: number
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onReorder: (orderedIds: string[]) => void
  onSetTag: (id: string, tag: string) => void
  /** Active workspace filter (null = All), shown as a clearable indicator. */
  activeWorkspace?: string | null
  onClearWorkspace?: () => void
}

export function Roster(props: Props): JSX.Element {
  const {
    roster,
    characters,
    presets,
    selectedId,
    viewMode,
    onSetViewMode,
    onGridRepeat,
    gridDensity,
    collapsed,
    hoverExpand,
    onSetCollapsed,
    navWidth,
    onNavWidth,
    groupMode,
    onSetGroupMode,
    collapsedGroups,
    onToggleGroup,
    minimized,
    onToggleMinimize,
    groupOrder,
    onReorderGroups,
    onSelect,
    onNew,
    onReplayIntro,
    onOpenSettings,
    onBroadcast,
    onAnalytics,
    showSpend,
    showCredits,
    budgetUsd,
    staleHideHours,
    onRestart,
    onClose,
    onReorder,
    onSetTag,
    activeWorkspace,
    onClearWorkspace
  } = props

  const totalUsd = roster.reduce((sum, s) => sum + (s.costUsd || 0), 0)
  const totalCredits = roster.reduce((sum, s) => sum + (s.creditsUsed || 0), 0)
  const overBudget = budgetUsd > 0 && totalUsd >= budgetUsd
  const charById = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)
  const presetName = (id: string | null): string =>
    id ? presets.find((p) => p.id === id)?.name ?? 'custom' : 'custom'

  function onResizeDown(e: React.PointerEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startW = navWidth
    const move = (ev: PointerEvent): void => onNavWidth(startW + (ev.clientX - startX))
    const up = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.body.style.cursor = 'col-resize'
  }

  const [navHover, setNavHover] = useState(false)
  // Per-group "show more": group names whose stale (unused) sessions are revealed.
  const [expandedStale, setExpandedStale] = useState<Set<string>>(() => new Set())
  function toggleStale(name: string): void {
    setExpandedStale((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
  // When the nav is manually collapsed (focus view), hovering the session list
  // floats it open as an overlay; leaving collapses it. `railed` = compact rail.
  const canFloat = collapsed && (hoverExpand ?? false)
  const railed = collapsed && !(canFloat && navHover)
  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current)
      clearTimeout(leaveTimer.current)
    },
    []
  )
  function startFloat(): void {
    if (canFloat) hoverTimer.current = setTimeout(() => setNavHover(true), 300)
  }
  function onRailEnter(): void {
    clearTimeout(leaveTimer.current)
    startFloat()
  }
  function onRailLeave(): void {
    clearTimeout(hoverTimer.current)
    // Grace period so moving the cursor toward an edge control doesn't collapse
    // the panel out from under the click.
    leaveTimer.current = setTimeout(() => setNavHover(false), 220)
  }
  // The collapsed-rail controls (expand / new session) are a no-float zone: while
  // the cursor is over them the panel must not float open, otherwise the hover
  // swaps the expand button out before the user can click it.
  function onHeadEnter(): void {
    clearTimeout(hoverTimer.current)
  }
  function onHeadLeave(e: React.MouseEvent): void {
    const aside = (e.currentTarget as HTMLElement).closest('.roster')
    // Re-arm the float only when moving deeper into the rail (the session list);
    // if the cursor is leaving the rail entirely, onRailLeave handles collapse.
    if (aside && e.relatedTarget instanceof Node && aside.contains(e.relatedTarget)) {
      startFloat()
    }
  }
  // Grouping applies in both the expanded nav and the collapsed rail — same
  // session order AND group headers — so the two views stay aligned. The rail
  // just renders each header compactly (truncated title + underline; the count
  // and chevron are hidden via CSS).
  const applyGrouping = groupMode !== 'none'
  useNowTick(applyGrouping && groupMode === 'recent')
  const dnd = useCardDnd(roster, railed ? 'disabled' : groupMode, onReorder, onSetTag)

  function renderCard(s: SessionInfo): JSX.Element {
    const h = dnd.cardHandlers(s)
    return (
      <SessionCard
        key={s.id}
        session={s}
        character={charById(s.characterId)}
        presetName={presetName(s.presetId)}
        selected={s.id === selectedId}
        compact={railed}
        showSpend={showSpend}
        showCredits={showCredits}
        draggable={h != null}
        isDragging={dnd.draggingId === s.id}
        isDragOver={dnd.overId === s.id && dnd.draggingId !== s.id}
        onSelect={() => onSelect(s.id)}
        onRestart={() => onRestart(s.id)}
        onClose={() => onClose(s.id)}
        onMinimize={() => onToggleMinimize(s.id)}
        minimized={minimized.has(s.id)}
        onDragStart={h?.onDragStart}
        onDragOver={h?.onDragOver}
        onDrop={h?.onDrop}
        onDragEnd={h?.onDragEnd}
      />
    )
  }

  const groups = applyGrouping ? groupSessions(roster, groupMode, groupOrder) : []
  const gdnd = useGroupReorder(
    groups.map((g) => g.name),
    onReorderGroups
  )

  // Hiding + per-bucket "show more" apply in the expanded nav (not the compact
  // rail). A session is hidden when it's been manually minimized, or — in group
  // (tag) sort — when it hasn't been prompted within staleHideHours.
  const canHide = !railed
  const staleCutoff = Date.now() - staleHideHours * 60 * 60 * 1000
  const isHidden = (s: SessionInfo): boolean =>
    minimized.has(s.id) ||
    (groupMode === 'tag' && staleHideHours > 0 && recencyOf(s) < staleCutoff)
  function renderBucket(items: SessionInfo[], key: string): React.ReactNode {
    if (!canHide) return items.map(renderCard)
    const { visible, hidden } = partitionHidden(items, isHidden)
    const open = expandedStale.has(key)
    return (
      <>
        {visible.map(renderCard)}
        {open && hidden.map(renderCard)}
        {hidden.length > 0 && (
          <button type="button" className="group__showmore" onClick={() => toggleStale(key)}>
            {open ? 'Show less' : `Show ${hidden.length} more`}
          </button>
        )}
      </>
    )
  }

  return (
    <aside
      className={`roster ${railed ? 'roster--collapsed' : ''} ${canFloat ? 'roster--float' : ''} ${
        canFloat && navHover ? 'is-expanded' : ''
      }`}
      onMouseEnter={onRailEnter}
      onMouseLeave={onRailLeave}
    >
      <div className="roster__header">
        {railed ? (
          <div className="roster__collapsed-head" onMouseEnter={onHeadEnter} onMouseLeave={onHeadLeave}>
            {viewMode === 'single' ? (
              <button
                type="button"
                className="icon-btn roster__expand"
                title="Expand sidebar"
                onClick={() => onSetCollapsed(false)}
              >
                <Icon name="chevron-right" />
              </button>
            ) : (
              // Grid view has no expand control; reserve its space so the "+" tile
              // sits where the floated new-session button does (no jump on hover).
              <span className="roster__expand-spacer" aria-hidden="true" />
            )}
            <button
              type="button"
              className="btn btn--newsession roster__new-tile"
              title="New session"
              onClick={onNew}
            >
              ＋
            </button>
          </div>
        ) : (
          <>
            <div className="roster__titlebar">
              <button
                type="button"
                className="roster__wordmark"
                title="Replay intro"
                onClick={onReplayIntro}
              >
                Crew
              </button>
              <div className="roster__titlebar-right">
                <span className="roster__count">
                  {roster.length} {roster.length === 1 ? 'SESSION' : 'SESSIONS'}
                </span>
                {viewMode === 'single' && (
                  <button
                    type="button"
                    className="icon-btn roster__collapse"
                    title={collapsed ? 'Keep sidebar open' : 'Collapse sidebar'}
                    onClick={() => onSetCollapsed(!collapsed)}
                  >
                    <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} />
                  </button>
                )}
              </div>
            </div>

            {activeWorkspace && (
              <div className="roster__workspace" title="Active workspace filter">
                <span className="roster__workspace-name">▚ {activeWorkspace}</span>
                {onClearWorkspace && (
                  <button
                    type="button"
                    className="roster__workspace-clear"
                    title="Show all sessions"
                    onClick={onClearWorkspace}
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            <button type="button" className="btn btn--newsession" onClick={onNew}>
              ＋ New Session
            </button>
          </>
        )}
      </div>

      <div className="roster__list">
        {roster.length === 0 ? (
          !railed && <div className="roster__empty">No sessions yet.</div>
        ) : applyGrouping ? (
          groups.map((g) => (
            <div className="group" key={g.name}>
              <button
                type="button"
                className={`group__header ${g.kind === 'needs' ? 'group__header--needs' : ''} ${gdnd.dragging === g.name ? 'is-dragging' : ''} ${(gdnd.overName === g.name && gdnd.dragging !== g.name) || dnd.overGroup === g.name ? 'is-drag-over' : ''}`}
                onClick={() => onToggleGroup(g.name)}
                title={groupMode === 'tag' ? 'Drag to reorder groups · drop a session here to move it' : 'Drag to reorder groups'}
                {...mergeHeaderDnd(gdnd.handlers(g.name), dnd, g.name)}
              >
                <span className="group__name">{g.name}</span>
                <span className="group__count">{g.items.length}</span>
                <span className="group__toggle" aria-hidden="true">
                  <Icon name={collapsedGroups.has(g.name) ? 'chevron-right' : 'chevron-down'} size={13} />
                </span>
              </button>
              {!collapsedGroups.has(g.name) && renderBucket(g.items, g.name)}
            </div>
          ))
        ) : (
          renderBucket(roster, '__all__')
        )}
      </div>

      <div className="roster__toolbar">
        <ViewToggle mode={viewMode} density={gridDensity} onChange={onSetViewMode} onGridRepeat={onGridRepeat} />
        {!railed && (
          <div className="roster__tools">
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
        )}
      </div>

      {roster.length > 0 && (showSpend || showCredits) && (
        <div
          className={`roster__footer ${overBudget ? 'is-over-budget' : ''}`}
          title={budgetUsd > 0 ? `Budget ${formatUsd(budgetUsd)}` : 'Totals across sessions'}
        >
          {!railed && (
            <span className="roster__footer-label">{overBudget ? '⚠ Over budget' : 'Total'}</span>
          )}
          <span className="roster__footer-total">
            {showSpend && <span>{formatUsd(totalUsd)}</span>}
            {showSpend && showCredits && <span className="roster__footer-sep"> · </span>}
            {showCredits && <span>{formatCredits(totalCredits)} cr</span>}
          </span>
        </div>
      )}

      {!railed && (
        <div className="roster__resize" onPointerDown={onResizeDown} title="Drag to resize" />
      )}
    </aside>
  )
}
