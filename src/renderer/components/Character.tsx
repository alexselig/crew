import type { SessionState } from '../../shared/types'
import { STATE_META } from '../state-meta'

interface Props {
  glyph: string
  state: SessionState
  size?: number
  /** Show the small status dot overlay (used on cards). */
  dot?: boolean
}

export function Character({ glyph, state, size = 26, dot = true }: Props): JSX.Element {
  const meta = STATE_META[state]
  return (
    <span
      className={`character character--${meta.anim}`}
      style={{ fontSize: size, width: size * 1.35, height: size * 1.35 }}
    >
      <span className="character__glyph">{glyph}</span>
      {dot && <span className="character__dot" style={{ background: meta.color }} />}
    </span>
  )
}
