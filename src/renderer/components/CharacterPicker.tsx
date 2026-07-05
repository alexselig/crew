import { useEffect, useRef, useState } from 'react'
import type { CharacterDef, SessionState } from '../../shared/types'
import { Character } from './Character'
import { CharacterArt, hasCharacterArt } from '../character-art'
import { CHARACTER_COLORS } from '../../shared/palette'

interface Props {
  characters: CharacterDef[]
  currentId: string
  /** Characters currently worn by OTHER active sessions (shown disabled). */
  usedIds?: string[]
  onPick: (id: string) => void
  /** Currently selected icon color. */
  color?: string
  /** When provided, a row of color swatches is shown; picking one calls this. */
  onSetColor?: (color: string) => void
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
  /** Show the status dot on the mascot trigger (used in grid tiles). */
  dot?: boolean
}

/** Current character as a trigger; click opens a glyph gallery to reassign it. */
export function CharacterPicker({
  characters,
  currentId,
  usedIds = [],
  onPick,
  color,
  onSetColor,
  variant = 'button',
  state = 'IDLE',
  size = 34,
  dot = false
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
          <Character glyph={current?.glyph ?? '●'} id={current?.id} color={color} state={state} size={size} dot={dot} />
        </button>
      ) : (
        <button
          type="button"
          className="char-picker__btn"
          title="Change character"
          onClick={() => setOpen((v) => !v)}
        >
          {current && hasCharacterArt(current.id) ? (
            <CharacterArt id={current.id} size={20} />
          ) : (
            (current?.glyph ?? '●')
          )}
        </button>
      )}
      {open && (
        <div className="char-picker__panel">
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
                  {hasCharacterArt(c.id) ? <CharacterArt id={c.id} size={24} /> : c.glyph}
                </button>
              )
            })}
          </div>
          {onSetColor && (
            <div className="char-picker__swatches" role="listbox" aria-label="Icon color">
              {CHARACTER_COLORS.map((col) => (
                <button
                  type="button"
                  key={col}
                  role="option"
                  aria-selected={col === color}
                  className={`char-picker__swatch ${col === color ? 'is-current' : ''}`}
                  style={{ background: col }}
                  title="Set icon color"
                  onClick={() => onSetColor(col)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
