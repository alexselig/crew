import { useEffect, useRef, useState } from 'react'
import type { CharacterDef } from '../../shared/types'

interface Props {
  characters: CharacterDef[]
  currentId: string
  /** Characters currently worn by OTHER active sessions (shown disabled). */
  usedIds?: string[]
  onPick: (id: string) => void
}

/** Current character as a button; click opens a glyph grid to reassign it. */
export function CharacterPicker({ characters, currentId, usedIds = [], onPick }: Props): JSX.Element {
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
    <div className="char-picker" ref={rootRef}>
      <button
        type="button"
        className="char-picker__btn"
        title="Change character"
        onClick={() => setOpen((v) => !v)}
      >
        {current?.glyph ?? '●'}
      </button>
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
