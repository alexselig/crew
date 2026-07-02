import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import type { GroupMode } from '../grouping'

export const GROUP_OPTIONS: Array<{ mode: GroupMode; label: string }> = [
  { mode: 'none', label: 'No grouping' },
  { mode: 'needs', label: 'Needs you' },
  { mode: 'tag', label: 'By group' }
]

interface Props {
  mode: GroupMode
  onChoose: (m: GroupMode) => void
}

/** Shared grouping control used by the roster header and the grid toolbar. */
export function GroupPicker({ mode, onChoose }: Props): JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent): void {
      if (!(e.target as HTMLElement).closest('.group-picker')) setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function choose(m: GroupMode): void {
    onChoose(m)
    setOpen(false)
  }

  return (
    <div className="group-picker">
      <button
        type="button"
        className={`icon-btn ${mode !== 'none' ? 'is-active' : ''}`}
        title="Group sessions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="group" />
      </button>
      {open && (
        <div className="group-menu" role="menu">
          {GROUP_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.mode}
              role="menuitemradio"
              aria-checked={mode === o.mode}
              className={`group-menu__item ${mode === o.mode ? 'is-active' : ''}`}
              onClick={() => choose(o.mode)}
            >
              <span className="group-menu__check">{mode === o.mode ? '✓' : ''}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
