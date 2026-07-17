import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  /** Rendered leading icon (an <Icon> or character mark). */
  icon?: ReactNode
  keywords?: string
  run: () => void
}

interface Props {
  items: PaletteItem[]
  onClose: () => void
}

/** ⌘K quick-switcher: fuzzy-filter sessions and actions, arrow keys + Enter. */
export function CommandPalette({ items, onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return items
    return items.filter((i) =>
      `${i.label} ${i.hint ?? ''} ${i.keywords ?? ''}`.toLowerCase().includes(s)
    )
  }, [q, items])

  useEffect(() => setIdx(0), [q])

  function onKey(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[idx]
      if (it) {
        it.run()
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Jump to a session or run an action…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette__list">
          {filtered.length === 0 ? (
            <div className="palette__empty">No matches</div>
          ) : (
            filtered.map((it, i) => (
              <button
                type="button"
                key={it.id}
                className={`palette__item ${i === idx ? 'is-active' : ''}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  it.run()
                  onClose()
                }}
              >
                <span className="palette__glyph">{it.icon}</span>
                <span className="palette__label">{it.label}</span>
                {it.hint && <span className="palette__hint">{it.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
