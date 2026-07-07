import { useEffect, useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import { Character } from './Character'
import { CHECKPOINT_PROMPT } from '../../shared/checkpoint'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  onClose: () => void
}

interface PromptTemplate {
  id: string
  label: string
  glyph: string
  hint: string
  text: string
}

// Reusable broadcast prompts. "Save & park" tells every selected session to
// checkpoint its work so the machine can be safely rebooted (see checkpoint.ts).
const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'park',
    label: 'Save & park',
    glyph: '🅿',
    hint: 'Each selected session commits its progress (no push), notes where it is, then goes idle — safe before a reboot or shutdown.',
    text: CHECKPOINT_PROMPT
  }
]

/** Send the same prompt to several sessions at once. */
export function BroadcastModal({ roster, characters, onClose }: Props): JSX.Element {
  const active = roster.filter((s) => s.status === 'active')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(active.map((s) => s.id)))

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggle(id: string): void {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  function send(): void {
    const payload = text.endsWith('\n') ? text : text + '\r'
    for (const id of selected) window.crew.sendInput(id, payload)
    onClose()
  }

  const charFor = (id: string): CharacterDef | undefined => characters.find((c) => c.id === id)

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Broadcast a prompt</h2>
        <p className="modal__hint">Send the same message to multiple sessions at once.</p>
        <div className="bcast-presets">
          {PROMPT_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="bcast-preset"
              title={t.hint}
              onClick={() => setText(t.text)}
            >
              <span className="bcast-preset__glyph">{t.glyph}</span>
              {t.label}
            </button>
          ))}
        </div>
        <textarea
          className="field__input field__input--area"
          placeholder="e.g. run the tests and report failures"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim() && selected.size > 0) {
              e.preventDefault()
              send()
            }
          }}
          rows={3}
          autoFocus
        />
        <div className="bcast-list">
          {active.length === 0 ? (
            <div className="bcast-empty">No active sessions.</div>
          ) : (
            active.map((s) => {
              const ch = charFor(s.characterId)
              return (
                <label key={s.id} className="bcast-row">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  <Character
                    glyph={ch?.glyph ?? '●'}
                    id={ch?.id}
                    color={s.color}
                    state={s.state}
                    size={20}
                    dot={false}
                    autopilot={s.autopilot}
                  />
                  <span className="bcast-label">{s.label}</span>
                </label>
              )
            })
          )}
        </div>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!text.trim() || selected.size === 0}
            onClick={send}
          >
            Send to {selected.size}
          </button>
        </div>
      </div>
    </div>
  )
}
