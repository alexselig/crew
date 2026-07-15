import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../../shared/types'
import { CharacterArt, hasCharacterArt } from '../character-art'

// A little side-view plane (nose to the right) drawn in `currentColor`, so it
// tints to the session's identity color like the mascots. The body is filled
// with the app background so the pilot mascot seated in the cockpit reads on top.
function Plane(): JSX.Element {
  return (
    <svg
      className="takeoff__plane"
      viewBox="0 0 96 64"
      fill="var(--bg)"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* wing strut (down-forward) */}
      <path d="M22 39 L27 51 L45 51 L39 39 Z" />
      {/* vertical tail fin */}
      <path d="M20 30 L13 13 L30 29 Z" />
      {/* fuselage */}
      <path d="M18 40 Q11 32 18 26 L54 26 Q68 28 76 34 Q68 40 54 40 L26 40 Q19 40 18 40 Z" />
      {/* rear horizontal stabilizer */}
      <path d="M13 33 L3 30 L3 37 L13 38 Z" />
      {/* propeller: hub + spinning blades at the nose */}
      <line x1="76" y1="23" x2="76" y2="45" />
      <line x1="72" y1="27" x2="80" y2="41" />
      <circle cx="76" cy="34" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

interface Flyer {
  key: number
  characterId: string
  color: string
  /** Vertical lane offset (px) so concurrent takeoffs don't perfectly overlap. */
  lane: number
  /** Small start delay (ms) to stagger simultaneous takeoffs. */
  delay: number
}

interface Props {
  roster: SessionInfo[]
}

let seq = 0

/**
 * Celebratory one-shot: when a session flips into autopilot, its mascot taxis
 * across the top title-bar band in a little plane and lifts off to the top-right
 * with a contrail. Fires only on the false→true `autopilot` edge (never on first
 * load or while already autonomous), and is skipped under reduced-motion.
 */
export function TakeoffLayer({ roster }: Props): JSX.Element | null {
  // Previous autopilot state per session id. `null` until the first snapshot so
  // sessions that are already autonomous on boot don't all take off at once.
  const prev = useRef<Map<string, boolean> | null>(null)
  const [flyers, setFlyers] = useState<Flyer[]>([])

  useEffect(() => {
    const next = new Map(roster.map((s) => [s.id, s.autopilot]))
    if (prev.current === null) {
      prev.current = next
      return
    }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (!reduce) {
      const born: Flyer[] = []
      let i = 0
      for (const s of roster) {
        const was = prev.current.get(s.id) ?? false
        if (s.autopilot && !was && hasCharacterArt(s.characterId)) {
          born.push({
            key: ++seq,
            characterId: s.characterId,
            color: s.color,
            lane: (i % 3) * 12,
            delay: i * 180
          })
          i++
        }
      }
      if (born.length > 0) setFlyers((f) => [...f, ...born])
    }
    prev.current = next
  }, [roster])

  function remove(key: number): void {
    setFlyers((f) => f.filter((x) => x.key !== key))
  }

  if (flyers.length === 0) return null

  return (
    <div className="takeoff-layer" aria-hidden="true">
      {flyers.map((f) => (
        <span
          key={f.key}
          className="takeoff"
          style={
            { color: f.color, '--lane': `${f.lane}px`, animationDelay: `${f.delay}ms` } as CSSProperties
          }
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) remove(f.key)
          }}
        >
          <span className="takeoff__trail" />
          <span className="takeoff__craft">
            <Plane />
            <span className="takeoff__pilot">
              <CharacterArt id={f.characterId} size={26} variant="pilot" />
            </span>
          </span>
        </span>
      ))}
    </div>
  )
}
