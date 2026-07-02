import type React from 'react'
import { useState } from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { formatUsd, formatCredits } from '../state-meta'
import { SessionCard } from './SessionCard'
import { GroupPicker } from './GroupPicker'
import { Icon } from './Icon'
import { groupSessions, type GroupMode } from '../grouping'
import { useGroupReorder } from '../useGroupReorder'
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
    onReorder
  } = props

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const waiting = roster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state))
  const totalUsd = roster.reduce((sum, s) => sum + (s.costUsd || 0), 0)
  const totalCredits = roster.reduce((sum, s) => sum + (s.creditsUsed || 0), 0)
  const overBudget = budgetUsd > 0 && totalUsd >= budgetUsd
  const charById = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)
  const presetName = (id: string | null): string =>
    id ? presets.find((p) => p.id === id)?.name ?? 'custom' : 'custom'

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
  function renderCard(s: SessionInfo): JSX.Element {
    const dnd = !grouped && !collapsed
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
        draggable={dnd}
        isDragging={dnd && draggingId === s.id}
        isDragOver={dnd && overId === s.id && draggingId !== s.id}
        onSelect={() => onSelect(s.id)}
        onRestart={() => onRestart(s.id)}
        onClose={() => onClose(s.id)}
        onDragStart={
          dnd
            ? (e) => {
                setDraggingId(s.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.id)
              }
            : undefined
        }
        onDragOver={
          dnd
            ? (e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== s.id) setOverId(s.id)
              }
            : undefined
        }
        onDrop={
          dnd
            ? (e) => {
                e.preventDefault()
                handleDrop(s.id)
              }
            : undefined
        }
        onDragEnd={dnd ? reset : undefined}
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
            {viewMode === 'grid' ? (
              <button
                type="button"
                className="icon-btn"
                title="Switch to focus view"
                onClick={() => onSetViewMode('single')}
              >
                ▤
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn"
                title="Expand sidebar"
                onClick={() => onSetCollapsed(false)}
              >
                »
              </button>
            )}
            <button type="button" className="icon-btn icon-btn--accent" title="New session" onClick={onNew}>
              ＋
            </button>
            <button type="button" className="icon-btn" title="Settings" onClick={onOpenSettings}>
              ⚙
            </button>
          </div>
        ) : (
          <>
            <div className="roster__titlebar">
              <div className="roster__title">
                Crew
                {waiting.length > 0 && (
                  <button
                    type="button"
                    className="roster__badge"
                    title={`${waiting.length} waiting for you — group by "Needs you"`}
                    onClick={() => onSetGroupMode('needs')}
                  >
                    {waiting.length}
                  </button>
                )}
              </div>
              <div className="roster__head-actions">
                <div className="view-toggle" role="tablist" aria-label="View mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'single'}
                    className={`view-toggle__btn ${viewMode === 'single' ? 'is-active' : ''}`}
                    title="Focus view"
                    onClick={() => onSetViewMode('single')}
                  >
                    ▤
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'grid'}
                    className={`view-toggle__btn ${viewMode === 'grid' ? 'is-active' : ''}`}
                    title="Grid view"
                    onClick={() => onSetViewMode('grid')}
                  >
                    ▦
                  </button>
                </div>
                <button type="button" className="icon-btn" title="Collapse sidebar" onClick={() => onSetCollapsed(true)}>
                  «
                </button>
                <GroupPicker mode={groupMode} onChoose={onSetGroupMode} />
                <button type="button" className="icon-btn" title="Broadcast a prompt" onClick={onBroadcast}>
                  <Icon name="broadcast" />
                </button>
                <button type="button" className="icon-btn" title="Activity & spend" onClick={onAnalytics}>
                  <Icon name="chart" />
                </button>
                <button type="button" className="icon-btn" title="Settings" onClick={onOpenSettings}>
                  ⚙
                </button>
              </div>
            </div>
            <button type="button" className="btn btn--primary" onClick={onNew}>
              ＋ New Session
            </button>
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
                className={`group__header ${g.kind === 'needs' ? 'group__header--needs' : ''} ${gdnd.dragging === g.name ? 'is-dragging' : ''} ${gdnd.overName === g.name && gdnd.dragging !== g.name ? 'is-drag-over' : ''}`}
                onClick={() => onToggleGroup(g.name)}
                title="Drag to reorder groups"
                {...gdnd.handlers(g.name)}
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
