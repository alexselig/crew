// Geometry churn: the layer below the structural census.
//
// flicker-census.ts counts *things* — canvases, terminals, tiles, WebGL
// contexts. The 7 Oct capture recorded four deltas in thirty-six minutes, two
// of them at startup, while the user was watching the screen jitter the whole
// time. So the structure holds still, and every suspect that works by mounting,
// unmounting or swapping a renderer is ruled out together.
//
// What a count cannot see is a thing that stays put but changes *size* or
// *position*. That is what jitter is: nothing appears or disappears, something
// moves a few pixels and moves back. So sample geometry instead of counts.
//
// Two rules follow from the failure of the first census:
//
//   1. Count at frame rate, not at poll rate. The main-process census samples
//      four times a second; an oscillation that happens every frame aliases
//      into that sampler and can read as perfectly still. The renderer counts
//      every frame and the census reads the running total, so a 60 Hz wobble
//      arrives as "240 changes in the last second" rather than as nothing.
//
//   2. Separate a move from a wobble. Resizing the window changes a dimension
//      once and it stays changed. Jitter returns to where it was. Counting
//      changes alone cannot tell those apart, so oscillations are counted
//      separately: a field taking a value it held two samples ago.
//
// Pure, with no DOM and no rAF, for the reason the eviction policy is: the part
// worth testing is the judgement about what counts as a wobble.

/** One sample of the geometry whose movement would be visible as jitter. */
export interface GeometrySample {
  /** Summed width of every <canvas>, in device pixels. */
  canvasW: number
  /** Summed height of every <canvas>, in device pixels. */
  canvasH: number
  /** CSS width of the first terminal canvas, in whole pixels. */
  screenW: number
  /** CSS height of the first terminal canvas, in whole pixels. */
  screenH: number
  /** Scroll offset of the first terminal viewport, in whole pixels. */
  scrollTop: number
  /** Window inner width, in whole CSS pixels. */
  winW: number
  /** Window inner height, in whole CSS pixels. */
  winH: number
  /** devicePixelRatio x100, so a display scale change is an integer move. */
  dpr: number
}

export const GEOMETRY_FIELDS = [
  'canvasW',
  'canvasH',
  'screenW',
  'screenH',
  'scrollTop',
  'winW',
  'winH',
  'dpr'
] as const

export type GeometryField = (typeof GEOMETRY_FIELDS)[number]

/** How much a capture moved, per field. */
export interface ChurnReport {
  /** Samples taken since the last reset — the denominator for every count. */
  frames: number
  /** Times each field took a different value than the sample before it. */
  changes: Record<GeometryField, number>
  /**
   * Times each field returned to the value it held two samples ago. A resize
   * moves a field once; jitter moves it back, so this is the number that
   * separates "the user dragged the window" from "the layout is fighting
   * itself".
   */
  oscillations: Record<GeometryField, number>
}

const zeroed = (): Record<GeometryField, number> =>
  Object.fromEntries(GEOMETRY_FIELDS.map((f) => [f, 0])) as Record<GeometryField, number>

export interface ChurnAccumulator {
  /** Fold one sample in. Cheap enough to call every frame. */
  add(sample: GeometrySample): void
  /** The report for everything added since the last reset. */
  report(): ChurnReport
  /** Zero the counts, keeping the last values so the next diff is continuous. */
  reset(): void
}

/**
 * Accumulate geometry churn across frames.
 *
 * Holds the previous two values per field, which is the least state that can
 * tell a one-way move from a wobble, and nothing else — this runs inside a
 * requestAnimationFrame loop, so it must not allocate per frame.
 */
export function createChurnAccumulator(): ChurnAccumulator {
  let frames = 0
  let changes = zeroed()
  let oscillations = zeroed()
  const prev: Partial<Record<GeometryField, number>> = {}
  const prev2: Partial<Record<GeometryField, number>> = {}

  return {
    add(sample: GeometrySample): void {
      frames++
      for (const f of GEOMETRY_FIELDS) {
        const v = sample[f]
        const p = prev[f]
        if (p !== undefined && v !== p) {
          changes[f]++
          // Returning to the value from two samples ago is a wobble, not a move.
          if (prev2[f] === v) oscillations[f]++
        }
        if (p !== undefined) prev2[f] = p
        prev[f] = v
      }
    },
    report(): ChurnReport {
      return { frames, changes: { ...changes }, oscillations: { ...oscillations } }
    },
    reset(): void {
      frames = 0
      changes = zeroed()
      oscillations = zeroed()
    }
  }
}

/** The field that wobbled most, or null if nothing wobbled. */
export function dominantWobble(report: ChurnReport): GeometryField | null {
  let best: GeometryField | null = null
  let bestCount = 0
  for (const f of GEOMETRY_FIELDS) {
    if (report.oscillations[f] > bestCount) {
      best = f
      bestCount = report.oscillations[f]
    }
  }
  return best
}

/**
 * The plain-language reading of a capture, so the log says what it means.
 *
 * Phrased as what to go and look at, because the whole point of the census is
 * that five fixes were aimed at causes nobody had observed.
 */
export function interpretChurn(report: ChurnReport): string {
  const field = dominantWobble(report)
  if (!field) {
    const moved = GEOMETRY_FIELDS.filter((f) => report.changes[f] > 0)
    if (!moved.length) {
      return `geometry held still across ${report.frames} frames: nothing resized or scrolled, so the jitter is paint inside a stable box — a CSS animation, a transition, or the compositor`
    }
    return `geometry moved but never came back (${moved.join(', ')}): a one-way resize, not a wobble`
  }
  const n = report.oscillations[field]
  const per = report.frames ? (n / report.frames).toFixed(2) : '0'
  const where: Record<GeometryField, string> = {
    canvasW: 'the terminal canvas is being resized every few frames — the fit loop is fighting itself (see fit-guard.ts)',
    canvasH: 'the terminal canvas is being resized every few frames — the fit loop is fighting itself (see fit-guard.ts)',
    screenW: 'the terminal element is changing width under layout — something upstream of the pane is resizing it',
    screenH: 'the terminal element is changing height under layout — something upstream of the pane is resizing it',
    scrollTop: 'the viewport is scrolling and snapping back, which is the scroll-position fight, not a repaint',
    winW: 'the window itself is changing width — this is outside the renderer',
    winH: 'the window itself is changing height — this is outside the renderer',
    dpr: 'the display scale is changing, so the window is moving between screens of different density'
  }
  return `${field} wobbled ${n}x in ${report.frames} frames (${per}/frame): ${where[field]}`
}
