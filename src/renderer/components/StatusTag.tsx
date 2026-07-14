import type { SessionState } from '../../shared/types'
import { STATE_META } from '../state-meta'

/**
 * The Obsidian status system, rendered consistently everywhere.
 *
 * - working   → cobalt label with a leading dot (or a solid cobalt chip in `chip` variant)
 * - attention → inverted ivory chip (ivory bg, near-black text) — the loudest thing on screen
 * - idle      → muted uppercase text
 * - error     → restrained danger label/chip
 */
export function StatusTag({
  state,
  variant = 'label',
  dot = true,
  className = ''
}: {
  state: SessionState
  variant?: 'label' | 'chip'
  /** Show the leading cobalt dot on the `working` label (default true). */
  dot?: boolean
  className?: string
}): JSX.Element {
  const m = STATE_META[state]
  return (
    <span
      className={`status status--${m.tone} ${variant === 'chip' ? 'status--chip' : ''} ${className}`.trim()}
    >
      {dot && m.tone === 'working' && variant === 'label' && <span className="status__dot" aria-hidden />}
      {m.short}
    </span>
  )
}
