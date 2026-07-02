import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, CharacterDef, Preset, SessionState } from '../../shared/types'
import { STATE_META } from '../state-meta'
import { Character } from './Character'
import { EditableLabel } from './EditableLabel'
import { CharacterPicker } from './CharacterPicker'
import { Since } from './Since'
import { TerminalView } from './TerminalView'
import { SkillsBar } from './SkillsBar'
import { focusTerminal } from '../terminal-pool'

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
  onSetTag: (id: string, tag: string) => void
  onRestart: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}

function TagChip({
  tag,
  groups,
  onCommit
}: {
  tag?: string
  groups: string[]
  onCommit: (t: string) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(tag ?? '')
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) {
      setDraft(tag ?? '')
      requestAnimationFrame(() => {
        ref.current?.focus()
        ref.current?.select()
      })
    }
  }, [editing, tag])
  function commit(): void {
    setEditing(false)
    const v = draft.trim()
    if (v !== (tag ?? '')) onCommit(v)
  }
  if (editing) {
    return (
      <>
        <input
          ref={ref}
          className="tag-chip tag-chip--input"
          value={draft}
          placeholder="group"
          list="crew-group-list"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
        <datalist id="crew-group-list">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </>
    )
  }
  return (
    <button
      type="button"
      className={`tag-chip ${tag ? '' : 'tag-chip--empty'}`}
      title="Assign this session to a group"
      onClick={() => setEditing(true)}
    >
      {tag ? `🏷 ${tag}` : '＋ group'}
    </button>
  )
}

function StatePill({ state, reason }: { state: SessionState; reason?: string }): JSX.Element {
  const m = STATE_META[state]
  return (
    <span
      className="pill"
      style={{ color: m.color, borderColor: `${m.color}55` }}
      title={reason ? `detected via: ${reason}` : undefined}
    >
      <span className="pill__dot" style={{ background: m.color }} />
      {m.label}
    </span>
  )
}

export function SessionView({
  session,
  characters,
  presets,
  usedCharacterIds,
  groups,
  onRename,
  onSetCharacter,
  onSetTag,
  onRestart,
  onClose,
  onNew
}: Props): JSX.Element {
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
        </div>
      </main>
    )
  }

  const character = characters.find((c) => c.id === session.characterId)
  const preset = session.presetId ? presets.find((p) => p.id === session.presetId) : null
  const presetName = session.presetId ? preset?.name ?? 'custom' : 'custom'
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
      <header className="session-header">
        <Character glyph={character?.glyph ?? '●'} state={session.state} size={30} dot={false} />
        <div className="session-header__id">
          <EditableLabel
            value={session.label}
            onCommit={(l) => onRename(session.id, l)}
            className="session-header__label"
          />
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
            <TagChip tag={session.tag} groups={groups} onCommit={(t) => onSetTag(session.id, t)} />
          </div>
        </div>

        <span className="session-header__spacer" />

        <StatePill state={session.state} reason={session.detectionReason} />
        <span className="session-header__since">
          <Since from={session.stateChangedAt} />
        </span>

        <CharacterPicker
          characters={characters}
          currentId={session.characterId}
          usedIds={usedCharacterIds}
          onPick={(cid) => onSetCharacter(session.id, cid)}
        />
        <button
          type="button"
          className="btn"
          title="Restart session"
          onClick={() => onRestart(session.id)}
        >
          ↻ Restart
        </button>
        <button
          type="button"
          className="btn btn--danger"
          title="Close session"
          onClick={() => onClose(session.id)}
        >
          Close
        </button>
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

      {active && <SkillsBar sessionId={session.id} />}

      <div className="session-body">
        {active ? (
          <TerminalView id={session.id} key={session.id} />
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
