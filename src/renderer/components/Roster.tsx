import type React from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { formatUsd, formatCredits } from '../state-meta'
import { SessionCard } from './SessionCard'
import { GroupPicker } from './GroupPicker'
import { Icon } from './Icon'
import { ViewToggle } from './ViewToggle'
import { groupSessions, type GroupMode } from '../grouping'
import { useGroupReorder } from '../useGroupReorder'
import { useCardDnd, mergeHeaderDnd } from '../useCardDnd'
import type { ViewMode } from '../hooks'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  presets: Preset[]
  selectedId: string | null
  viewMode: ViewMode
  onSetViewMode: (m: ViewMode) => void
  collapsed: boolean
  onSetCollapsed: (v: boolean) => void
  navWidth: number
  onNavWidth: (w: number) => void
  groupMode: GroupMode
  onSetGroupMode: (m: GroupMode) => void
  collapsedGroups: Set<string>
  onToggleGroup: (name: string) => void
  groupOrder: string[]
  onReorderGroups: (names: string[]) => void
  onSelect: (id: string) => void
  onNew: () => void
  onOpenSettings: () => void
  onBroadcast: () => void
  onAnalytics: () => void
  showSpend: boolean
  showCredits: boolean
  budgetUsd: number
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onReorder: (orderedIds: string[]) => void
  onSetTag: (id: string, tag: string) => void
}

export function Roster(props: Props): JSX.Element {
  const {
    roster,
    characters,
    presets,
    selectedId,
    viewMode,
    onSetViewMode,
    collapsed,
    onSetCollapsed,
    navWidth,
    onNavWidth,
    groupMode,
    onSetGroupMode,
    collapsedGroups,
    onToggleGroup,
    groupOrder,
    onReorderGroups,
    onSelect,
    onNew,
    onOpenSettings,
    onBroadcast,
    onAnalytics,
    showSpend,
    showCredits,
    budgetUsd,
    onRestart,
    onClose,
    onReorder,
    onSetTag
  } = props

  const waiting = roster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state))
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

  const grouped = groupMode !== 'none' && !collapsed
  const dnd = useCardDnd(roster, collapsed ? 'disabled' : groupMode, onReorder, onSetTag)

  function renderCard(s: SessionInfo): JSX.Element {
    const h = dnd.cardHandlers(s)
    return (
      <SessionCard
        key={s.id}
        session={s}
        character={charById(s.characterId)}
        presetName={presetName(s.presetId)}
        selected={s.id === selectedId}
        compact={collapsed}
        showSpend={showSpend}
        showCredits={showCredits}
        draggable={h != null}
        isDragging={dnd.draggingId === s.id}
        isDragOver={dnd.overId === s.id && dnd.draggingId !== s.id}
        onSelect={() => onSelect(s.id)}
        onRestart={() => onRestart(s.id)}
        onClose={() => onClose(s.id)}
        onDragStart={h?.onDragStart}
        onDragOver={h?.onDragOver}
        onDrop={h?.onDrop}
        onDragEnd={h?.onDragEnd}
      />
    )
  }

  const groups = grouped ? groupSessions(roster, groupMode, groupOrder) : []
  const gdnd = useGroupReorder(
    groups.map((g) => g.name),
    onReorderGroups
  )

  return (
    <aside className={`roster ${collapsed ? 'roster--collapsed' : ''}`}>
      <div className="roster__header">
        {collapsed ? (
          <div className="roster__collapsed-head">
            <div className="roster__collapsed-top">
              <button
                type="button"
                className="icon-btn"
                title={viewMode === 'grid' ? 'Focus view' : 'Grid view'}
                onClick={() => onSetViewMode(viewMode === 'grid' ? 'single' : 'grid')}
              >
                <Icon name={viewMode === 'grid' ? 'columns' : 'grid'} />
              </button>
              {viewMode === 'single' && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Expand sidebar"
                  onClick={() => onSetCollapsed(false)}
                >
                  <Icon name="chevrons-right" />
                </button>
              )}
            </div>
            <button
              type="button"
              className="icon-btn icon-btn--accent roster__new-tile"
              title="New session"
              onClick={onNew}
            >
              ＋
            </button>
          </div>
        ) : (
          <>
            <div className="roster__titlebar">
              <span className="roster__wordmark">Crew</span>
              <div className="roster__titlebar-right">
                {waiting.length > 0 ? (
                  <button
                    type="button"
                    className="status status--attention roster__waiting"
                    title={`${waiting.length} waiting for you — group by attention`}
                    onClick={() => onSetGroupMode('needs')}
                  >
                    {waiting.length} WAITING
                  </button>
                ) : (
                  <span className="roster__count">
                    {roster.length} {roster.length === 1 ? 'SESSION' : 'SESSIONS'}
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn roster__collapse"
                  title="Collapse sidebar"
                  onClick={() => onSetCollapsed(true)}
                >
                  <Icon name="chevrons-left" size={12} />
                </button>
              </div>
            </div>

            <button type="button" className="btn btn--newsession" onClick={onNew}>
              ＋ New Session
            </button>

            <div className="roster__toolbar">
              <ViewToggle mode={viewMode} onChange={onSetViewMode} />
              <div className="roster__tools">
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
          </>
        )}
      </div>

      <div className="roster__list">
        {roster.length === 0 ? (
          !collapsed && <div className="roster__empty">No sessions yet.</div>
        ) : grouped ? (
          groups.map((g) => (
            <div className="group" key={g.name}>
              <button
                type="button"
                className={`group__header ${g.kind === 'needs' ? 'group__header--needs' : ''} ${gdnd.dragging === g.name ? 'is-dragging' : ''} ${(gdnd.overName === g.name && gdnd.dragging !== g.name) || dnd.overGroup === g.name ? 'is-drag-over' : ''}`}
                onClick={() => onToggleGroup(g.name)}
                title={groupMode === 'tag' ? 'Drag to reorder groups · drop a session here to move it' : 'Drag to reorder groups'}
                {...mergeHeaderDnd(gdnd.handlers(g.name), dnd, g.name)}
              >
                <span className="group__chevron">{collapsedGroups.has(g.name) ? '▸' : '▾'}</span>
                <span className="group__name">{g.name}</span>
                <span className="group__count">{g.items.length}</span>
              </button>
              {!collapsedGroups.has(g.name) && g.items.map(renderCard)}
            </div>
          ))
        ) : (
          roster.map(renderCard)
        )}
      </div>

      {roster.length > 0 && (showSpend || showCredits) && (
        <div
          className={`roster__footer ${overBudget ? 'is-over-budget' : ''}`}
          title={budgetUsd > 0 ? `Budget ${formatUsd(budgetUsd)}` : 'Totals across sessions'}
        >
          {!collapsed && (
            <span className="roster__footer-label">{overBudget ? '⚠ Over budget' : 'Total'}</span>
          )}
          <span className="roster__footer-total">
            {showSpend && <span>{formatUsd(totalUsd)}</span>}
            {showSpend && showCredits && <span className="roster__footer-sep"> · </span>}
            {showCredits && <span>{formatCredits(totalCredits)} cr</span>}
          </span>
        </div>
      )}

      {!collapsed && (
        <div className="roster__resize" onPointerDown={onResizeDown} title="Drag to resize" />
      )}
    </aside>
  )
}
