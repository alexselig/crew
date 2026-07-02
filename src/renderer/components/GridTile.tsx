import type React from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { STATE_META } from '../state-meta'
import { Character } from './Character'
import { Since } from './Since'
import { TerminalView } from './TerminalView'

interface Props {
  session: SessionInfo
  character?: CharacterDef
  selected: boolean
  isDragging?: boolean
  isDragOver?: boolean
  onSelect: () => void
  onExpand: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}

/** One project in the grid: a compact header + its live, scrollable terminal,
 * auto-scrolled to the latest output (where the agent is asking for input).
 * The header is a drag handle for rearranging tiles. */
export function GridTile({
  session,
  character,
  selected,
  isDragging = false,
  isDragOver = false,
  onSelect,
  onExpand,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: Props): JSX.Element {
  const meta = STATE_META[session.state]
  const needsYou = session.status === 'active' && NEEDS_YOU.includes(session.state)
  const active = session.status === 'active'

  return (
    <div
      className={`tile ${needsYou ? 'is-needsyou' : ''} ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
      style={needsYou ? { borderColor: meta.color } : undefined}
      onClick={onSelect}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className="tile__header"
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        title="Drag to rearrange"
      >
        <Character glyph={character?.glyph ?? '●'} state={session.state} size={18} dot={false} />
        <span className="tile__label" title={session.label}>
          {session.label}
        </span>
        <span className="tile__state" style={{ color: meta.color }}>
          <span className="tile__dot" style={{ background: meta.color }} />
          {meta.label}
        </span>
        <span className="tile__since">
          <Since from={session.stateChangedAt} />
        </span>
        <button
          type="button"
          className="mini-btn mini-btn--icon"
          title="Open in focus view"
          onClick={(e) => {
            e.stopPropagation()
            onExpand()
          }}
        >
          ⤢
        </button>
      </div>
      <div className="tile__body">
        {active ? (
          <TerminalView id={session.id} focusOnMount={false} />
        ) : (
          <div className="tile__exited">
            {session.status === 'error' ? '⚠︎' : '✔︎'} session {session.status}
          </div>
        )}
      </div>
    </div>
  )
}
