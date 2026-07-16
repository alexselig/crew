import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hasCharacterArt } from '../character-art'
import { PlaneCraft, PLANE_IDS, type PlaneId } from '../plane-art'

let seq = 0

/** Pick a random plane, so the craft varies from one takeoff to the next. */
function randomPlane(): PlaneId {
  return PLANE_IDS[Math.floor(Math.random() * PLANE_IDS.length)]
}

interface Flight {
  /** Remounts the overlay so a new takeoff always replays from the start. */
  key: number
  planeId: PlaneId
}

/**
 * Per-session autopilot takeoff. Watches one session's `autopilot` flag and, on a
 * false→true edge, returns a one-shot `flight` that a title bar renders as a
 * plane flying across it. Fires only after mount (never on the first snapshot, so
 * sessions already autonomous on load don't take off), only when the mascot has
 * line art, and never under reduced-motion. The baseline is keyed by session id,
 * so switching which session a reused header shows (focus view) can't misfire.
 */
export function useTakeoff(
  sessionId: string,
  autopilot: boolean,
  characterId: string
): { flight: Flight | null; end: () => void } {
  const prev = useRef<{ id: string; on: boolean } | null>(null)
  const [flight, setFlight] = useState<Flight | null>(null)

  useEffect(() => {
    const p = prev.current
    prev.current = { id: sessionId, on: autopilot }
    // New or changed session identity: record the baseline only, never fire.
    if (!p || p.id !== sessionId) return
    if (autopilot && !p.on && hasCharacterArt(characterId)) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      if (!reduce) setFlight({ key: ++seq, planeId: randomPlane() })
    }
  }, [sessionId, autopilot, characterId])

  const end = useCallback(() => setFlight(null), [])
  return { flight, end }
}

interface Props {
  /** Changes per takeoff; used as the React key so the animation restarts. */
  flightKey: number
  planeId: PlaneId
  characterId: string
  /** Session identity color; the plane + seated mascot render in it. */
  color: string
  onEnd: () => void
}

/**
 * The takeoff overlay: absolutely fills its title bar and flies the session's
 * mascot-piloted plane across it, left to right with a smooth climb. Sized to the
 * bar at mount (height → craft size, width → travel distance) so it fits both the
 * tall focus header and the shorter grid-tile header. Retires itself when the
 * fade animation ends.
 */
export function HeaderTakeoff({ flightKey, planeId, characterId, color, onEnd }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const craftH = Math.max(34, Math.round(h * 0.92))
    el.style.setProperty('--craft-h', `${craftH}px`)
    // Measure the laid-out craft width (after the height var is applied) so the
    // plane enters fully off the left edge and exits fully off the right edge.
    const fly = el.firstElementChild as HTMLElement | null
    const craftW = fly ? fly.offsetWidth : Math.round(craftH * 1.4)
    el.style.setProperty('--x0', `${-(craftW + 28)}px`)
    el.style.setProperty('--x1', `${w + 28}px`)
  }, [flightKey])

  return (
    <div
      ref={ref}
      className="header-takeoff"
      aria-hidden="true"
      style={{ color }}
      onAnimationEnd={(e) => {
        // Only the container's own fade animation retires the flyer, not the
        // bubbled transform-animation ends from the nested layers.
        if (e.target === e.currentTarget) onEnd()
      }}
    >
      <span className="header-takeoff__fly">
        <span className="header-takeoff__craft">
          <PlaneCraft planeId={planeId} characterId={characterId} />
        </span>
      </span>
    </div>
  )
}
