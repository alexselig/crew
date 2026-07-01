import { useEffect, useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  onClose: () => void
}

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

  const glyph = (id: string): string => characters.find((c) => c.id === id)?.glyph ?? '●'

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Broadcast a prompt</h2>
        <p className="modal__hint">Send the same message to multiple sessions at once.</p>
        <textarea
          className="field__input field__input--area"
          placeholder="e.g. run the tests and report failures"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          autoFocus
        />
        <div className="bcast-list">
          {active.length === 0 ? (
            <div className="bcast-empty">No active sessions.</div>
          ) : (
            active.map((s) => (
              <label key={s.id} className="bcast-row">
                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                <span className="bcast-glyph">{glyph(s.characterId)}</span>
                <span className="bcast-label">{s.label}</span>
              </label>
            ))
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
