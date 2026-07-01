import type React from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { STATE_META, formatUsd, formatCredits } from '../state-meta'
import { Character } from './Character'
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
      <div className="card__top">
        <Character glyph={character?.glyph ?? '●'} state={session.state} size={22} dot={false} />
        <span className="card__label" title={session.label}>
          {session.label}
        </span>
        <span className="card__gutter" aria-hidden>
          <span className="card__state-dot" style={{ background: meta.color }} />
        </span>
      </div>

      <div className="card__sub" title={`${session.cwd} · ${presetName}`}>
        {shortenPath(session.cwd)} · {presetName}
      </div>

      <div className="card__foot">
        <span className="card__state-text" style={{ color: meta.color }}>
          {meta.label}
        </span>
        <span className="card__since">
          · <Since from={session.stateChangedAt} />
        </span>
        {showSpend && (
          <span className="card__cost" title="Spend this session (as reported by the agent)">
            · {formatUsd(session.costUsd)}
          </span>
        )}
        {showCredits && (
          <span className="card__cost" title="Credits/AIC used this session (as reported by the agent)">
            · {formatCredits(session.creditsUsed)} cr
          </span>
        )}
        <span className="card__spacer" />
        {inactive && (
          <button
            type="button"
            className="mini-btn"
            title="Restart session"
            onClick={(e) => {
              e.stopPropagation()
              onRestart()
            }}
          >
            Restart
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

function shortenPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}
