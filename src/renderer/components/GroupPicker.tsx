import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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

  // Flip the flyout above the button when it would overflow the bottom of the
  // viewport (e.g. the roster toolbar sits at the bottom of the screen).
  useLayoutEffect(() => {
    if (!open) {
      setDropUp(false)
      return
    }
    const anchor = rootRef.current?.getBoundingClientRect()
    const menuHeight = menuRef.current?.offsetHeight ?? 0
    if (!anchor) return
    const spaceBelow = window.innerHeight - anchor.bottom
    const spaceAbove = anchor.top
    setDropUp(spaceBelow < menuHeight + 8 && spaceAbove > spaceBelow)
  }, [open])

  function choose(m: GroupMode): void {
    onChoose(m)
    setOpen(false)
  }

  return (
    <div className="group-picker" ref={rootRef}>
      <button
        type="button"
        className={`icon-btn ${mode !== 'none' ? 'is-active' : ''}`}
        title="Group sessions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="filter" />
      </button>
      {open && (
        <div ref={menuRef} className={`group-menu ${dropUp ? 'group-menu--up' : ''}`} role="menu">
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
