import { useState } from 'react'
import type { SessionInfo, CharacterDef, Preset } from '../../shared/types'

import { StatusTag } from './StatusTag'
import { EditableLabel } from './EditableLabel'
import { CharacterPicker } from './CharacterPicker'
import { Icon } from './Icon'
import { Since } from './Since'
import { TerminalHost } from './TerminalHost'
import { TranscriptPane } from './TranscriptPane'
import { AssetsPanel } from './AssetsPanel'
import { SkillsBar } from './SkillsBar'
import { TagChip } from './TagChip'
import { ResumeSets } from './ResumeSets'
import { focusTerminal } from '../terminal/facade'
import { usePendingInputTokens } from '../input-meter'
import { useTakeoff, HeaderTakeoff } from './HeaderTakeoff'

interface Props {
  session: SessionInfo | null
  characters: CharacterDef[]
  presets: Preset[]
  /** Characters worn by other active sessions (to keep assignments unique). */
  usedCharacterIds: string[]
  /** Group labels already in use, for tag autocomplete. */
  groups: string[]
  onRename: (id: string, label: string) => void
  onSetCharacter: (id: string, characterId: string) => void
  onSetColor: (id: string, color: string) => void
  onSetTag: (id: string, tag: string) => void
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  /** App-wide Beta Enhanced Terminal Interface toggle. */
  enhancedTerminal: boolean
  /** Warn in the session footer before submitting more than this many input
   * tokens at once (0 = off). */
  inputTokenWarn: number
}

export function SessionView({
  session,
  characters,
  presets,
  usedCharacterIds,
  groups,
  onRename,
  onSetCharacter,
  onSetColor,
  onSetTag,
  onRestart,
  onClose,
  onNew,
  enhancedTerminal,
  inputTokenWarn
}: Props): JSX.Element {
  const [metaOpen, setMetaOpen] = useState(false)
  // Which representation of the session is shown: the raw terminal (default,
  // source of truth) or the typed Transcript read layer.
  const [pane, setPane] = useState<'terminal' | 'transcript'>('terminal')
  const { flight, end } = useTakeoff(session?.id ?? '', session?.autopilot ?? false, session?.characterId ?? '')
  if (!session) {
    return (
      <main className="session-view session-view--empty">
        <div className="empty">
          <div className="empty__glyph">🛠️</div>
          <h2>No session selected</h2>
          <p>Launch an AI agent and Crew will watch for when it needs you.</p>
          <button type="button" className="btn btn--primary btn--lg" onClick={onNew}>
            ＋ New Session
          </button>
          <ResumeSets />
        </div>
      </main>
    )
  }

  const preset = session.presetId ? presets.find((p) => p.id === session.presetId) : null
  const presetName = session.presetId ? preset?.name ?? 'custom' : 'custom'
  const character = characters.find((c) => c.id === session.characterId)
  const active = session.status === 'active'
  const needsApproval = session.state === 'WAITING_APPROVAL'
  const approveKeys = preset?.approveKeys ?? 'y\r'
  const denyKeys = preset?.denyKeys ?? 'n\r'

  function reply(keys: string): void {
    window.crew.sendInput(session!.id, keys)
    focusTerminal(session!.id)
  }

  return (
    <main className="session-view">
      <header className={`session-header ${flight ? 'is-taking-off' : ''}`}>
        <CharacterPicker
          variant="mascot"
          size={38}
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
        <div className="session-header__id">
          <div className="session-header__titlerow">
            <EditableLabel
              value={session.label}
              onCommit={(l) => onRename(session.id, l)}
              className="session-header__label"
            />
            <TagChip tag={session.tag} groups={groups} onCommit={(t) => onSetTag(session.id, t)} />
            <button
              type="button"
              className={`session-header__disclosure ${metaOpen ? 'is-open' : ''}`}
              title={metaOpen ? 'Hide details' : 'Show details'}
              aria-expanded={metaOpen}
              onClick={() => setMetaOpen((v) => !v)}
            >
              <Icon name="chevron-down" size={12} />
            </button>
          </div>
          {metaOpen && (
            <div className="session-header__meta">
              <span title={session.cwd}>{session.cwd}</span>
              <span className="dot-sep">·</span>
              <span>{presetName}</span>
              {session.pid != null && (
                <>
                  <span className="dot-sep">·</span>
                  <span>pid {session.pid}</span>
                </>
              )}
            </div>
          )}
        </div>

        <span className="session-header__spacer" />

        {active && enhancedTerminal && (
          <span className="pane-toggle">
            <button
              type="button"
              className={`btn pane-toggle__btn ${pane === 'terminal' ? 'is-active' : ''}`}
              title="Raw terminal"
              onClick={() => setPane('terminal')}
            >
              Terminal
            </button>
            <button
              type="button"
              className={`btn pane-toggle__btn ${pane === 'transcript' ? 'is-active' : ''}`}
              title="Typed transcript (read layer)"
              onClick={() => setPane('transcript')}
            >
              Transcript
            </button>
          </span>
        )}

        <span className="session-header__since">
          <Since from={session.stateChangedAt} />
        </span>
        <StatusTag
          state={session.state}
          variant="chip"
          className="session-header__status"
        />

        <button
          type="button"
          className="btn"
          title="Restart session"
          onClick={() => onRestart(session.id)}
        >
          Restart
        </button>
        <button
          type="button"
          className="btn btn--danger"
          title="Close session"
          onClick={() => onClose(session.id)}
        >
          Close
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
      </header>

      {active && needsApproval && (
        <div className="approval-bar">
          <span className="approval-bar__label">⚠︎ Approval needed</span>
          <div className="approval-bar__actions">
            <button type="button" className="btn btn--approve" onClick={() => reply(approveKeys)}>
              Approve
            </button>
            <button type="button" className="btn btn--deny" onClick={() => reply(denyKeys)}>
              Deny
            </button>
            <button
              type="button"
              className="btn"
              title="Accept the highlighted option"
              onClick={() => reply('\r')}
            >
              ↵ Enter
            </button>
            <button type="button" className="btn" title="Send Escape" onClick={() => reply('\x1b')}>
              Esc
            </button>
          </div>
        </div>
      )}

      <div className={`session-body ${active ? 'session-body--split' : ''}`}>
        {active ? (
          <>
            <div className="term-wrap">
              {enhancedTerminal && pane === 'transcript' ? (
                <TranscriptPane
                  sessionId={session.id}
                  enhanced={enhancedTerminal}
                  agentSessionId={session.agentSessionId}
                  character={character}
                  agentLabel={presetName}
                />
              ) : (
                <>
                  <TerminalHost id={session.id} enhanced={enhancedTerminal} key={session.id} />
                  <SkillsBar sessionId={session.id} agent={session.command} />
                </>
              )}
              <InputWarnBar sessionId={session.id} threshold={inputTokenWarn} />
            </div>
            <AssetsPanel sessionId={session.id} />
          </>
        ) : (
          <div className="exited-pane">
            <div className="exited-pane__glyph">{session.status === 'error' ? '⚠️' : '✔︎'}</div>
            <p>
              Session {session.status}
              {session.exitCode != null ? ` (code ${session.exitCode})` : ''}.
            </p>
            {session.errorMessage && <p className="exited-pane__msg">{session.errorMessage}</p>}
            <div className="exited-pane__actions">
              <button type="button" className="btn btn--primary" onClick={() => onRestart(session.id)}>
                ↻ Restart
              </button>
              <button type="button" className="btn" onClick={() => onClose(session.id)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

/**
 * A footer warning shown below the terminal/composer when a large amount of
 * input is sitting unsent — e.g. a pasted rehydration blob. It only occupies
 * space once tripped, so the terminal shrinks slightly to make room. Off when
 * threshold <= 0.
 */
function InputWarnBar({ sessionId, threshold }: { sessionId: string; threshold: number }): JSX.Element | null {
  const tokens = usePendingInputTokens(sessionId)
  if (threshold <= 0 || tokens < threshold) return null
  return (
    <div className="input-warn" role="status" aria-live="polite">
      <span className="input-warn__icon" aria-hidden>
        ▲
      </span>
      <span className="input-warn__text">
        Large input — about <strong>{tokens.toLocaleString()}</strong> tokens ready to send. Submitting
        will push a lot of context at once (warns past {threshold.toLocaleString()}).
      </span>
    </div>
  )
}
