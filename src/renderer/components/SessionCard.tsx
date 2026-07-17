import type React from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { STATE_META, formatUsd, formatCredits } from '../state-meta'
import { Character } from './Character'
import { StatusTag } from './StatusTag'
import { Since } from './Since'

interface Props {
  session: SessionInfo
  character?: CharacterDef
  presetName: string
  selected: boolean
  compact?: boolean
  showSpend?: boolean
  showCredits?: boolean
  draggable?: boolean
  onSelect: () => void
  onRestart: () => void
  onClose: () => void
  /** Minimize (hide behind the bucket's "show more"). Omitted → no button. */
  onMinimize?: () => void
  minimized?: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: (e: React.DragEvent) => void
}

export function SessionCard({
  session,
  character,
  presetName,
  selected,
  compact,
  showSpend,
  showCredits,
  draggable = true,
  onSelect,
  onRestart,
  onClose,
  onMinimize,
  minimized,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: Props): JSX.Element {
  const meta = STATE_META[session.state]
  const inactive = session.status !== 'active'

  if (compact) {
    return (
      <div
        className={`card card--compact ${selected ? 'is-selected' : ''} ${
          inactive ? 'is-inactive' : ''
        } ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
        role="button"
        tabIndex={0}
        draggable={draggable}
        title={`${session.label} — ${meta.label}`}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect()
          }
        }}
      >
        <Character glyph={character?.glyph ?? '●'} id={character?.id} color={session.color} state={session.state} size={48} autopilot={session.autopilot} />
      </div>
    )
  }

  return (
    <div
      className={`card ${selected ? 'is-selected' : ''} ${inactive ? 'is-inactive' : ''} ${
        isDragging ? 'is-dragging' : ''
      } ${isDragOver ? 'is-drag-over' : ''}`}
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <Character glyph={character?.glyph ?? '●'} id={character?.id} color={session.color} state={session.state} size={48} dot={false} autopilot={session.autopilot} badge={false} />

      <div className="card__main">
        <span className="card__name" title={session.label}>
          {session.label}
        </span>
        <span className="card__meta" title={`${session.cwd} · ${presetName}`}>
          <Since from={session.stateChangedAt} />
          {showSpend && <> · {formatUsd(session.costUsd)}</>}
          {showCredits && <> · {formatCredits(session.creditsUsed)} cr</>}
        </span>
      </div>

      <span className="card__status">
        <StatusTag state={session.state} dot={false} />
      </span>

      <div className="card__actions">
        {inactive && (
          <button
            type="button"
            className="mini-btn mini-btn--icon"
            title="Restart session"
            onClick={(e) => {
              e.stopPropagation()
              onRestart()
            }}
          >
            ↻
          </button>
        )}
        {onMinimize && (
          <button
            type="button"
            className="mini-btn mini-btn--icon"
            title={minimized ? 'Restore session' : 'Minimize — hide until “Show more”'}
            onClick={(e) => {
              e.stopPropagation()
              onMinimize()
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="mini-btn mini-btn--icon mini-btn--close"
          title={inactive ? 'Dismiss' : 'Close session'}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}
