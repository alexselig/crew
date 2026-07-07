import type { SessionState } from '../../shared/types'
import { STATE_META } from '../state-meta'
import { CharacterArt, hasCharacterArt } from '../character-art'

interface Props {
  glyph: string
  state: SessionState
  /** Character id; when line-art exists for it, the illustrated face is shown instead of the emoji. */
  id?: string
  /** Identity color for the illustrated face (via currentColor); falls back to ivory. */
  color?: string
  size?: number
  /** Show the small status dot overlay (used on cards). */
  dot?: boolean
  /** When the session is on autopilot (Claude acceptEdits / Copilot autopilot), wear the pilot costume. */
  autopilot?: boolean
}

export function Character({ glyph, state, id, color, size = 26, dot = true, autopilot = false }: Props): JSX.Element {
  const meta = STATE_META[state]
  const art = id !== undefined && hasCharacterArt(id)
  return (
    <span
      className={`character character--${meta.anim}${autopilot ? ' character--autopilot' : ''}`}
      style={{ fontSize: size, width: size * 1.35, height: size * 1.35, color }}
      title={autopilot ? 'autopilot' : undefined}
    >
      {art ? (
        <CharacterArt id={id as string} size={size} variant={autopilot ? 'pilot' : 'base'} />
      ) : (
        <span className="character__glyph">{glyph}</span>
      )}
      {dot && <span className="character__dot" style={{ background: meta.color }} />}
    </span>
  )
}
