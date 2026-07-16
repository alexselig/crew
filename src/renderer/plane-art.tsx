// Plane art for the autopilot takeoff. Four minimal, elegant side-view craft
// (nose right) drawn in `currentColor` at the character line-art weight, each
// seating the session's pilot mascot in one SVG (viewBox 96×64). A plane is
// assigned per session deterministically, so different sessions fly different
// craft — same spirit as the mascot roster.
import { pilotArtGroup } from './character-art'

interface PlaneDef {
  /** Main structural stroke weight (matched to the mascot line art). */
  sw: number
  /** Main outline paths (stroked, body filled with --bg). */
  paths: string[]
  /** Lighter detail paths. */
  fine: string[]
  /** Filled dots [cx, cy, r] (hubs/rivets). */
  dots: [number, number, number][]
  /** Thin outline circles [cx, cy, r] (portholes). */
  rings: [number, number, number][]
  /** Where to seat the mascot (translate + scale from the 512 pilot space). */
  pilot: { x: number; y: number; size: number }
}

const SW = 1.3

const PLANES: Record<string, PlaneDef> = {
  // Classic prop — one clean fuselage, a soft wing, a tail fin, a slim prop.
  classic: {
    sw: SW,
    paths: [
      'M14 36 Q10 30 17 28 L52 27 Q66 27 79 33 Q66 39 52 39 L20 39 Q15 39 14 36 Z',
      'M30 39 Q30 46 36 46 L52 46 Q57 46 55 39',
      'M16 28 L10 16 L23 30'
    ],
    fine: ['M79 26 Q82 33 79 40', 'M78 26 Q75 33 78 40'],
    dots: [[79, 33, 1.4]],
    rings: [],
    pilot: { x: 27, y: 0, size: 31 }
  },
  // Sleek jet — a single leaf fuselage, one swept wing, one swept fin.
  jet: {
    sw: SW,
    paths: [
      'M8 37 Q46 30 91 35 Q46 40 8 37 Z',
      'M42 39 L33 49 L57 44 Z',
      'M15 34 L8 23 L25 33'
    ],
    fine: ['M32 33 Q42 28 50 33'],
    dots: [],
    rings: [],
    pilot: { x: 30, y: 1, size: 28 }
  },
  // Rocket — capsule + nose cone, two fins, a small flame, a porthole.
  rocket: {
    sw: SW,
    paths: [
      'M20 27 L58 27 Q77 27 87 34 Q77 41 58 41 L20 41 Q13 41 13 34 Q13 27 20 27 Z',
      'M20 27 L12 18 L26 27',
      'M20 41 L12 50 L26 41',
      'M13 31 L6 34 L13 37'
    ],
    fine: [],
    dots: [],
    rings: [[61, 34, 2.4]],
    pilot: { x: 24, y: -1, size: 30 }
  },
  // Hang glider — one delta wing with the mascot hanging below in a control bar.
  hangglider: {
    sw: SW,
    paths: [
      'M6 24 L90 24 L48 35 Z',
      'M41 35 L48 45 L55 35'
    ],
    fine: ['M48 24 L48 35', 'M46 38 L45 43', 'M50 38 L51 43'],
    dots: [],
    rings: [],
    pilot: { x: 34, y: 30, size: 27 }
  }
}

export type PlaneId = keyof typeof PLANES
export const PLANE_IDS = Object.keys(PLANES) as PlaneId[]

/** Deterministically assign a plane to a session id (stable across renders). */
export function planeFor(seed: string): PlaneId {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return PLANE_IDS[h % PLANE_IDS.length]
}

interface PlaneCraftProps {
  planeId: PlaneId
  /** Character id whose pilot (aviator) art is seated in the craft. */
  characterId: string
}

/** One SVG: the plane in `currentColor` with the pilot mascot seated inside. */
export function PlaneCraft({ planeId, characterId }: PlaneCraftProps): JSX.Element {
  const def = PLANES[planeId] ?? PLANES.classic
  const p = def.pilot
  return (
    <svg
      className="takeoff__plane"
      viewBox="0 0 96 64"
      fill="var(--bg)"
      stroke="currentColor"
      strokeWidth={def.sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g>
        {def.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      <g fill="none" strokeWidth={def.sw * 0.82}>
        {def.fine.map((d, i) => (
          <path key={i} d={d} />
        ))}
        {def.rings.map(([cx, cy, r], i) => (
          <circle key={i} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <g fill="currentColor" stroke="none">
        {def.dots.map(([cx, cy, r], i) => (
          <circle key={i} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <g transform={`translate(${p.x},${p.y}) scale(${p.size / 512})`} fill="currentColor" stroke="none">
        {pilotArtGroup(characterId)}
      </g>
    </svg>
  )
}
