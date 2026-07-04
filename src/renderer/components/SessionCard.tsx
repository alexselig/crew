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
        <Character glyph={character?.glyph ?? '●'} state={session.state} size={26} />
        <span className="card__cname">{session.label}</span>
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
      <Character glyph={character?.glyph ?? '●'} state={session.state} size={30} dot={false} />

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
        <StatusTag state={session.state} />
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
        <button
          type="button"
          className="mini-btn mini-btn--icon"
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
