import type React from 'react'
import { useEffect, useState } from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { formatUsd, formatCredits } from '../state-meta'
import { SessionCard } from './SessionCard'
import { Icon } from './Icon'
import type { ViewMode } from '../hooks'

type GroupMode = 'none' | 'needs' | 'tag'

const GROUP_OPTIONS: Array<{ mode: GroupMode; label: string }> = [
  { mode: 'none', label: 'No grouping' },
  { mode: 'needs', label: 'Needs you' },
  { mode: 'tag', label: 'By tag' }
]

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
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const saved = localStorage.getItem('crew.groupMode')
    if (saved === 'none' || saved === 'needs' || saved === 'tag') return saved
    return localStorage.getItem('crew.groupByTag') === '1' ? 'tag' : 'none'
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem('crew.collapsedGroups') || '[]'))
    } catch {
      return new Set<string>()
    }
  })

  function chooseMode(m: GroupMode): void {
    setGroupMode(m)
    localStorage.setItem('crew.groupMode', m)
    setMenuOpen(false)
  }
  function toggleGroup(name: string): void {
    setCollapsedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      localStorage.setItem('crew.collapsedGroups', JSON.stringify([...n]))
      return n
    })
  }

  useEffect(() => {
    if (!menuOpen) return
    function onDoc(e: MouseEvent): void {
      if (!(e.target as HTMLElement).closest('.group-picker')) setMenuOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

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

  const groups: Array<{ name: string; items: SessionInfo[]; kind?: 'needs' }> = []
  if (grouped && groupMode === 'tag') {
    const idx = new Map<string, number>()
    for (const s of roster) {
      const name = s.tag && s.tag.trim() ? s.tag : 'Untagged'
      if (!idx.has(name)) {
        idx.set(name, groups.length)
        groups.push({ name, items: [] })
      }
      groups[idx.get(name) as number].items.push(s)
    }
  } else if (grouped && groupMode === 'needs') {
    const needsYou = (s: SessionInfo): boolean => s.status === 'active' && NEEDS_YOU.includes(s.state)
    const needs = roster.filter(needsYou)
    const rest = roster.filter((s) => !needsYou(s))
    if (needs.length) groups.push({ name: 'Needs you', items: needs, kind: 'needs' })
    if (rest.length) groups.push({ name: 'Working', items: rest })
  }

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
                    onClick={() => chooseMode('needs')}
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
                <div className="group-picker">
                  <button
                    type="button"
                    className={`icon-btn ${groupMode !== 'none' ? 'is-active' : ''}`}
                    title="Group sessions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((v) => !v)}
                  >
                    <Icon name="group" />
                  </button>
                  {menuOpen && (
                    <div className="group-menu" role="menu">
                      {GROUP_OPTIONS.map((o) => (
                        <button
                          type="button"
                          key={o.mode}
                          role="menuitemradio"
                          aria-checked={groupMode === o.mode}
                          className={`group-menu__item ${groupMode === o.mode ? 'is-active' : ''}`}
                          onClick={() => chooseMode(o.mode)}
                        >
                          <span className="group-menu__check">{groupMode === o.mode ? '✓' : ''}</span>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
                className={`group__header ${g.kind === 'needs' ? 'group__header--needs' : ''}`}
                onClick={() => toggleGroup(g.name)}
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
