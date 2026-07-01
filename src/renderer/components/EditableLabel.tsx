import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onCommit: (next: string) => void
  className?: string
}

/** Click-to-rename label. Enter/blur commits, Escape cancels. */
export function EditableLabel({ value, onCommit, className }: Props): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(value)
      // Focus + select on next frame so the field is mounted.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [editing, value])

  function commit(): void {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onCommit(next)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`editable-label editable-label--input ${className ?? ''}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={`editable-label ${className ?? ''}`}
      title="Click to rename"
      onClick={() => setEditing(true)}
    >
      {value}
    </button>
  )
}
