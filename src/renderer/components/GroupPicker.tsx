import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { GroupMode } from '../grouping'
import type { CustomView, SessionPresentation } from '../../shared/types'

export const GROUP_OPTIONS: Array<{ mode: GroupMode; label: string }> = [
  { mode: 'none', label: 'No grouping' },
  { mode: 'needs', label: 'Needs you' },
  { mode: 'tag', label: 'By group' },
  { mode: 'recent', label: 'By recent' }
]

interface Props {
  presentation: SessionPresentation
  customViews: CustomView[]
  onChoose: (presentation: SessionPresentation) => void
  onCreateCustomView: (opener: HTMLElement | null) => void
  onEditCustomView: (id: string, opener: HTMLElement | null) => void
}

function summaryFor(view: CustomView): string {
  const modeLabel = view.mode === 'curated-only' ? 'Curated only' : 'Ranked + all'
  const ranked = `${view.items.length} ranked`
  return `${modeLabel} · ${ranked}`
}

/** Shared session-view control used by the roster header and the grid toolbar. */
export function GroupPicker({
  presentation,
  customViews,
  onChoose,
  onCreateCustomView,
  onEditCustomView
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

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

  function chooseBuiltin(mode: GroupMode): void {
    onChoose({ kind: 'builtin', mode })
    setOpen(false)
  }

  function chooseCustom(viewId: string): void {
    onChoose({ kind: 'custom', viewId })
    setOpen(false)
  }

  return (
    <div className="group-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        title="Choose session view"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sort" />
      </button>
      {open && (
        <div ref={menuRef} className={`group-menu ${dropUp ? 'group-menu--up' : ''}`} role="menu">
          {GROUP_OPTIONS.map((o) => (
            <button
              type="button"
              key={o.mode}
              role="menuitemradio"
              aria-checked={presentation.kind === 'builtin' && presentation.mode === o.mode}
              className={`group-menu__item ${
                presentation.kind === 'builtin' && presentation.mode === o.mode ? 'is-active' : ''
              }`}
              onClick={() => chooseBuiltin(o.mode)}
            >
              <span className="group-menu__check">
                {presentation.kind === 'builtin' && presentation.mode === o.mode ? '✓' : ''}
              </span>
              {o.label}
            </button>
          ))}
          <div className="group-menu__section">Custom views</div>
          {customViews.map((view) => {
            const active = presentation.kind === 'custom' && presentation.viewId === view.id
            return (
              <div className="group-menu__row" key={view.id}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`group-menu__item group-menu__item--custom ${active ? 'is-active' : ''}`}
                  onClick={() => chooseCustom(view.id)}
                >
                  <span className="group-menu__check">{active ? '✓' : ''}</span>
                  <span className="group-menu__content">
                    <span className="group-menu__label">{view.name}</span>
                    <span className="group-menu__meta">{summaryFor(view)}</span>
                  </span>
                </button>
                {active && (
                  <button
                    type="button"
                    role="menuitem"
                    className="group-menu__edit"
                    onClick={() => {
                      onEditCustomView(view.id, triggerRef.current)
                      setOpen(false)
                    }}
                  >
                    Edit view
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            role="menuitem"
            className="group-menu__item group-menu__item--action"
            onClick={() => {
              onCreateCustomView(triggerRef.current)
              setOpen(false)
            }}
          >
            <span className="group-menu__check">+</span>
            New custom view
          </button>
        </div>
      )}
    </div>
  )
}
