import type React from 'react'
import { useState } from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { STATE_META, formatUsd } from '../state-meta'
import { SessionCard } from './SessionCard'
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
  onSelect: (id: string) => void
  onJump: (id: string) => void
  onNew: () => void
  onOpenSettings: () => void
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
    onJump,
    onNew,
    onOpenSettings,
    onRestart,
    onClose,
    onReorder
  } = props

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const waiting = roster.filter((s) => s.status === 'active' && NEEDS_YOU.includes(s.state))
  const totalUsd = roster.reduce((sum, s) => sum + (s.costUsd || 0), 0)
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

  return (
    <aside className={`roster ${collapsed ? 'roster--collapsed' : ''}`}>
      <div className="roster__header">
        {collapsed ? (
          <div className="roster__collapsed-head">
            <button type="button" className="icon-btn" title="Expand sidebar" onClick={() => onSetCollapsed(false)}>
              »
            </button>
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
                  <span className="roster__badge" title={`${waiting.length} waiting for you`}>
                    {waiting.length}
                  </span>
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

      {!collapsed && waiting.length > 0 && (
        <div className="needs-you">
          <div className="needs-you__label">Needs you</div>
          {waiting.map((s) => {
            const meta = STATE_META[s.state]
            return (
              <button
                type="button"
                key={s.id}
                className="needs-you__btn"
                style={{ borderColor: `${meta.color}66` }}
                onClick={() => onJump(s.id)}
                title={`Jump to ${s.label}`}
              >
                <span className="needs-you__glyph">{charById(s.characterId)?.glyph ?? '●'}</span>
                <span className="needs-you__name">{s.label}</span>
                <span className="needs-you__dot" style={{ background: meta.color }} />
              </button>
            )
          })}
        </div>
      )}

      <div className="roster__list">
        {roster.length === 0 ? (
          !collapsed && <div className="roster__empty">No sessions yet.</div>
        ) : (
          roster.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              character={charById(s.characterId)}
              presetName={presetName(s.presetId)}
              selected={s.id === selectedId}
              compact={collapsed}
              isDragging={draggingId === s.id}
              isDragOver={overId === s.id && draggingId !== s.id}
              onSelect={() => onSelect(s.id)}
              onRestart={() => onRestart(s.id)}
              onClose={() => onClose(s.id)}
              onDragStart={(e) => {
                setDraggingId(s.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', s.id)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== s.id) setOverId(s.id)
              }}
              onDrop={(e) => {
                e.preventDefault()
                handleDrop(s.id)
              }}
              onDragEnd={reset}
            />
          ))
        )}
      </div>

      {roster.length > 0 && (
        <div className="roster__footer" title={`Total spend: ${formatUsd(totalUsd)}`}>
          {!collapsed && <span className="roster__footer-label">Total spend</span>}
          <span className="roster__footer-total">{formatUsd(totalUsd)}</span>
        </div>
      )}

      {!collapsed && (
        <div className="roster__resize" onPointerDown={onResizeDown} title="Drag to resize" />
      )}
    </aside>
  )
}
