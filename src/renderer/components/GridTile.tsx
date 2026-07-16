import type React from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { CharacterPicker } from './CharacterPicker'
import { StatusTag } from './StatusTag'
import { Since } from './Since'
import { TerminalView } from './TerminalView'
import { TagChip } from './TagChip'

interface Props {
  session: SessionInfo
  character?: CharacterDef
  characters: CharacterDef[]
  usedCharacterIds: string[]
  selected: boolean
  isDragging?: boolean
  isDragOver?: boolean
  groups: string[]
  onSelect: () => void
  onExpand: () => void
  onClose: () => void
  onSetCharacter: (id: string, characterId: string) => void
  onSetColor: (id: string, color: string) => void
  onSetTag: (tag: string) => void
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
  characters,
  usedCharacterIds,
  selected,
  isDragging = false,
  isDragOver = false,
  groups,
  onSelect,
  onExpand,
  onClose,
  onSetCharacter,
  onSetColor,
  onSetTag,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: Props): JSX.Element {
  const needsYou = session.status === 'active' && NEEDS_YOU.includes(session.state)
  const active = session.status === 'active'

  return (
    <div
      className={`tile ${needsYou ? 'is-needsyou' : ''} ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
      data-session-id={session.id}
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
        <span
          className="tile__char"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
        >
          <CharacterPicker
            variant="mascot"
            size={48}
            state={session.state}
            color={session.color}
            autopilot={session.autopilot}
            badge={false}
            characters={characters}
            currentId={session.characterId}
            usedIds={usedCharacterIds}
            onPick={(cid) => onSetCharacter(session.id, cid)}
            onSetColor={(col) => onSetColor(session.id, col)}
          />
        </span>
        <span className="tile__label" title={session.label}>
          {session.label}
        </span>
        <TagChip tag={session.tag} groups={groups} onCommit={onSetTag} />
        <span className="tile__status">
          <StatusTag state={session.state} />
          <span className="tile__since">
            <Since from={session.stateChangedAt} />
          </span>
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
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
          </svg>
        </button>
        <button
          type="button"
          className="mini-btn mini-btn--icon"
          title="Close session"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          ✕
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
