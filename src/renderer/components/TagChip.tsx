import { useEffect, useRef, useState } from 'react'

/**
 * Editable "group" chip shared by the immersive session header and the grid
 * tiles, so the two stay in sync. Clicking opens an inline input with a
 * datalist of existing group names. `draggable={false}` + stopPropagation keep
 * it usable inside a draggable/selectable tile header.
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
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
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
