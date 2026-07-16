import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../../shared/types'
import { hasCharacterArt } from '../character-art'
import { PlaneCraft, planeFor, type PlaneId } from '../plane-art'

interface Flyer {
  key: number
  characterId: string
  color: string
  /** Which plane this session flies (assigned deterministically by session id). */
  planeId: PlaneId
  /** Vertical lane offset (px) so concurrent takeoffs don't perfectly overlap. */
  lane: number
}

interface Props {
  roster: SessionInfo[]
}

let seq = 0

/**
 * Celebratory one-shot: when a session flips into autopilot, its mascot flies a
 * little plane across the top title-bar band and lifts off to the top-right with
 * a contrail. Each session is assigned one of several plane designs by id, so
 * different sessions fly different craft. Fires only on the false→true
 * `autopilot` edge (never on first load or while already autonomous); skipped
 * under reduced-motion. Horizontal, vertical, and fade are separate layers so
 * the motion eases smoothly (see the .takeoff CSS).
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
            planeId: planeFor(s.id),
            lane: (i % 3) * 14
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
          style={{ color: f.color, '--lane': `${f.lane}px` } as CSSProperties}
          // The fade animation lives on this element; its end (not a child's
          // bubbling transform-animation end) retires the flyer.
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) remove(f.key)
          }}
        >
          <span className="takeoff__fly">
            <span className="takeoff__craft">
              <span className="takeoff__trail" />
              <PlaneCraft planeId={f.planeId} characterId={f.characterId} />
            </span>
          </span>
        </span>
      ))}
    </div>
  )
}
