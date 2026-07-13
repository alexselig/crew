import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * Editable "group" chip shared by the immersive session header and the grid
 * tiles, so the two stay in sync. Clicking opens an inline input plus a dropdown
 * that lists ALL existing groups to pick from (a native <datalist> only shows
 * options matching the current value, so it hid every group but the current one).
 * `draggable={false}` + stopPropagation keep it usable inside a draggable/
 * selectable tile header.
 */
export function TagChip({
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
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(tag ?? '')
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, tag])

  // Close on outside click.
  useEffect(() => {
    if (!editing) return
    function onDoc(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setEditing(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [editing])

  // Flip the menu above the chip when it would overflow the viewport bottom.
  useLayoutEffect(() => {
    if (!editing) {
      setDropUp(false)
      return
    }
    const anchor = rootRef.current?.getBoundingClientRect()
    const menuH = menuRef.current?.offsetHeight ?? 0
    if (!anchor) return
    const below = window.innerHeight - anchor.bottom
    setDropUp(below < menuH + 8 && anchor.top > below)
  }, [editing, draft, groups])

  function commit(value: string): void {
    setEditing(false)
    const v = value.trim()
    if (v !== (tag ?? '')) onCommit(v)
  }

  // List every other group; as the user types, narrow by substring (but an
  // untouched draft still shows the full list, which the datalist never did).
  const q = draft.trim().toLowerCase()
  const others = groups.filter((g) => g.toLowerCase() !== (tag ?? '').toLowerCase())
  const filtered =
    q && q !== (tag ?? '').toLowerCase() ? others.filter((g) => g.toLowerCase().includes(q)) : others

  if (editing) {
    return (
      <span
        className="tag-chip-edit"
        ref={rootRef}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="tag-chip tag-chip--input"
          value={draft}
          placeholder="group"
          draggable={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft)
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
        <div ref={menuRef} className={`tag-menu ${dropUp ? 'tag-menu--up' : ''}`} role="listbox">
          {tag && (
            <button
              type="button"
              className="tag-menu__item tag-menu__item--clear"
              onClick={() => commit('')}
            >
              ✕ No group
            </button>
          )}
          {filtered.map((g) => (
            <button
              type="button"
              key={g}
              role="option"
              className="tag-menu__item"
              onClick={() => commit(g)}
            >
              {g}
            </button>
          ))}
          {filtered.length === 0 && !tag && (
            <span className="tag-menu__empty">No other groups yet — type to create one</span>
          )}
        </div>
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`tag-chip ${tag ? '' : 'tag-chip--empty'}`}
      title="Assign this session to a group"
      draggable={false}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
    >
      {tag ? tag : '＋ group'}
    </button>
  )
}
