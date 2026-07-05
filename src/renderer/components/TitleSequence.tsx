import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CharacterArt } from '../character-art'
import { CHARACTER_COLORS } from '../../shared/palette'
import { CrewLogo } from './CrewLogo'

type Phase = 'idle' | 'converge' | 'grow' | 'settle' | 'reveal'

interface IconSpec {
  id: string
  /** Center position as a percentage of the viewport (viewport is 0–100). */
  x: number
  y: number
  /** Relative size multiplier. */
  s: number
  /** Fly-in duration (ms) — scales with distance so far icons arrive later. */
  dur: number
  /** Target tint (from the icon color set) reached by the end of the fly-in. */
  tint: string
}

const ANIMALS = [
  'fox', 'bear', 'deer', 'owl', 'rabbit', 'squirrel', 'raccoon', 'hedgehog',
  'lion', 'monkey', 'frog', 'elephant', 'koala', 'panda', 'penguin', 'duck'
]

// Build a jittered grid of faint faces at the SAME density as the visible area
// but extending well past the viewport, so ~1/5 are on-screen and ~4/5 stream
// in from off-screen. Icons converge at a distance-scaled speed, so the outer
// ones arrive later and the fly-in runs noticeably longer.
function buildField(): { icons: IconSpec[]; convergeMs: number } {
  const rand = (a: number, b: number): number => a + Math.random() * (b - a)
  const MIN = -61
  const MAX = 161
  const STEP = 21 // matches the visible scatter's spacing
  const JIT = STEP * 0.42
  const icons: IconSpec[] = []
  for (let gy = MIN; gy <= MAX; gy += STEP) {
    for (let gx = MIN; gx <= MAX; gx += STEP) {
      const x = gx + rand(-JIT, JIT)
      const y = gy + rand(-JIT, JIT)
      // Keep the centered logo lockup clear.
      if (Math.abs(x - 50) < 21 && Math.abs(y - 50) < 20) continue
      const d = Math.hypot(x - 50, y - 50)
      icons.push({
        id: ANIMALS[Math.floor(Math.random() * ANIMALS.length)],
        x,
        y,
        s: rand(0.85, 1.2),
        dur: Math.round(640 + d * 11),
        tint: CHARACTER_COLORS[Math.floor(Math.random() * CHARACTER_COLORS.length)]
      })
    }
  }
  const convergeMs = Math.max(...icons.map((i) => i.dur)) + 140
  return { icons, convergeMs }
}

const GROW_MS = 420
const SETTLE_MS = 240
const HOLD_MS = 2000
const REVEAL_MS = 600

interface Props {
  /** Called once the sequence has fully played. */
  onDone: () => void
}

/**
 * Title launch sequence. Opens on the scattered "start" poster with a
 * "click to start" prompt; the animation only begins when the user clicks. It
 * then flies every animal icon behind the logo while shrinking them away — the
 * on-screen ones first, then a longer tail of off-screen ones — zooms the lone
 * logo in by 10% and back to its original size, holds for a couple of seconds,
 * then fades out to reveal the app.
 */
export function TitleSequence({ onDone }: Props): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const timers = useRef<number[]>([])
  const finished = useRef(false)
  // The field (positions, sizes, per-icon durations, tints) is generated once
  // per mount so it stays stable across the phase re-renders.
  const { icons, convergeMs } = useMemo(buildField, [])

  function clearTimers(): void {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
  }

  function finish(): void {
    if (finished.current) return
    finished.current = true
    clearTimers()
    onDone()
  }

  // Kick off the animation on the first click; ignore clicks once running.
  function start(): void {
    if (phase !== 'idle') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    if (reduce) {
      setPhase('reveal')
      timers.current.push(window.setTimeout(finish, REVEAL_MS))
      return
    }
    setPhase('converge')
    timers.current.push(window.setTimeout(() => setPhase('grow'), convergeMs))
    timers.current.push(window.setTimeout(() => setPhase('settle'), convergeMs + GROW_MS))
    // Hold on the lone, original-size logo for a beat before revealing the app.
    timers.current.push(
      window.setTimeout(() => setPhase('reveal'), convergeMs + GROW_MS + SETTLE_MS + HOLD_MS)
    )
    timers.current.push(
      window.setTimeout(finish, convergeMs + GROW_MS + SETTLE_MS + HOLD_MS + REVEAL_MS)
    )
  }

  useEffect(() => clearTimers, [])

  return (
    <div
      className={`intro intro--${phase}`}
      onClick={start}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          start()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Click to start Crew"
    >
      <div className="intro__field" aria-hidden="true">
        {icons.map((ic, i) => (
          <span
            key={i}
            className="intro__icon"
            style={
              {
                '--tx': `${ic.x - 50}vw`,
                '--ty': `${ic.y - 50}vh`,
                '--tint': ic.tint,
                '--dur': `${ic.dur}ms`
              } as CSSProperties
            }
          >
            <span className="intro__icon-inner">
              <CharacterArt id={ic.id} size={Math.round(64 * ic.s)} />
            </span>
          </span>
        ))}
      </div>
      <div className="intro__logo">
        <CrewLogo />
      </div>
      <div className="intro__start" aria-hidden="true">
        click to start
      </div>
    </div>
  )
}
