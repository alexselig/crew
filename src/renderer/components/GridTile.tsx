import { useState } from 'react'
import type React from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { NEEDS_YOU } from '../../shared/types'
import { CharacterPicker } from './CharacterPicker'
import { StatusTag } from './StatusTag'
import { Since } from './Since'
import { TerminalHost } from './TerminalHost'
import { TranscriptPane } from './TranscriptPane'
import { TagChip } from './TagChip'
import { SkillsBar } from './SkillsBar'
import { useTakeoff, HeaderTakeoff } from './HeaderTakeoff'

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
  onMinimize: () => void
  minimized: boolean
  /** App-wide Beta Enhanced Terminal Interface toggle. */
  enhanced: boolean
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
  onMinimize,
  minimized,
  enhanced,
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
  // Which representation this tile shows: the raw terminal (default) or the
  // typed Transcript. Per-tile so grid views can mix. Gated by the beta flag.
  const [pane, setPane] = useState<'terminal' | 'transcript'>('terminal')
  const { flight, end } = useTakeoff(session.id, session.autopilot, session.characterId)

  return (
    <div
      className={`tile ${needsYou ? 'is-needsyou' : ''} ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
      data-session-id={session.id}
      onClick={onSelect}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        className={`tile__header ${flight ? 'is-taking-off' : ''}`}
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
        {active && enhanced && (
          <span
            className="tile__pane-toggle"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={`mini-btn mini-btn--icon ${pane === 'terminal' ? 'is-active' : ''}`}
              title="Terminal"
              aria-pressed={pane === 'terminal'}
              onClick={(e) => {
                e.stopPropagation()
                setPane('terminal')
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="4 7 9 12 4 17" />
                <line x1="12" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <button
              type="button"
              className={`mini-btn mini-btn--icon ${pane === 'transcript' ? 'is-active' : ''}`}
              title="Transcript"
              aria-pressed={pane === 'transcript'}
              onClick={(e) => {
                e.stopPropagation()
                setPane('transcript')
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="14" y2="18" />
              </svg>
            </button>
          </span>
        )}
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
        {flight && (
          <HeaderTakeoff
            flightKey={flight.key}
            planeId={flight.planeId}
            characterId={session.characterId}
            color={session.color}
            onEnd={end}
          />
        )}
      </div>
      <div className="tile__body">
        {active ? (
          enhanced && pane === 'transcript' ? (
            <span onClick={(e) => e.stopPropagation()} className="tile__transcript">
              <TranscriptPane
                sessionId={session.id}
                enhanced={enhanced}
                agentSessionId={session.agentSessionId}
                character={character}
              />
            </span>
          ) : (
            <>
              <TerminalHost id={session.id} enhanced={enhanced} focusOnMount={false} />
              <span onClick={(e) => e.stopPropagation()}>
                <SkillsBar sessionId={session.id} agent={session.command} />
              </span>
            </>
          )
        ) : (
          <div className="tile__exited">
            {session.status === 'error' ? '⚠︎' : '✔︎'} session {session.status}
          </div>
        )}
      </div>
    </div>
  )
}
