import { useEffect, useRef, useState } from 'react'
import type { CharacterDef, SessionState } from '../../shared/types'
import { Character } from './Character'

interface Props {
  characters: CharacterDef[]
  currentId: string
  /** Characters currently worn by OTHER active sessions (shown disabled). */
  usedIds?: string[]
  onPick: (id: string) => void
  /**
   * `button` (default) shows a small bordered glyph button.
   * `mascot` shows the large animated Character as the trigger (used in the
   * session header, where clicking the mascot opens the gallery).
   */
  variant?: 'button' | 'mascot'
  /** Session state, so the mascot trigger can animate. */
  state?: SessionState
  /** Mascot size in px (mascot variant only). */
  size?: number
}

/** Current character as a trigger; click opens a glyph gallery to reassign it. */
export function CharacterPicker({
  characters,
  currentId,
  usedIds = [],
  onPick,
  variant = 'button',
  state = 'IDLE',
  size = 34
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = characters.find((c) => c.id === currentId)
  const used = new Set(usedIds)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className={`char-picker ${variant === 'mascot' ? 'char-picker--mascot' : ''}`} ref={rootRef}>
      {variant === 'mascot' ? (
        <button
          type="button"
          className="char-picker__mascot"
          title="Change character"
          onClick={() => setOpen((v) => !v)}
        >
          <Character glyph={current?.glyph ?? '●'} state={state} size={size} dot={false} />
        </button>
      ) : (
        <button
          type="button"
          className="char-picker__btn"
          title="Change character"
          onClick={() => setOpen((v) => !v)}
        >
          {current?.glyph ?? '●'}
        </button>
      )}
      {open && (
        <div className="char-picker__grid" role="listbox">
          {characters.map((c) => {
            const taken = used.has(c.id) && c.id !== currentId
            return (
              <button
                type="button"
                key={c.id}
                role="option"
                aria-selected={c.id === currentId}
                disabled={taken}
                className={`char-picker__cell ${c.id === currentId ? 'is-current' : ''} ${
                  taken ? 'is-taken' : ''
                }`}
                title={taken ? `${c.name} (in use)` : c.name}
                onClick={() => {
                  onPick(c.id)
                  setOpen(false)
                }}
              >
                {c.glyph}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
