// What the window is actually doing at the moment the user sees a flicker.
//
// Five explanations for CB-1 have now been falsified against evidence rather
// than argued away: the mascot bob (calm motion is on and its migration ran),
// WebGL context contention (a budget, slot reclamation and synchronous context
// release all shipped), roster reordering by state (detection debounces a
// WAITING verdict before committing it), reordering by recency (recency is the
// user's last prompt, which does not move while an agent talks), and renderer
// death (five weeks of logging contain zero render-process-gone events).
//
// Each of those fixes was aimed at a cause nobody had observed. The missing
// ingredient is not another theory, it is a measurement: a flicker is something
// *changing* on screen, so record what changes, and the layer that is changing
// names the culprit.
//
//   canvas/webgl moving   -> the renderer is swapping WebGL for DOM and back
//   xterms/tiles moving   -> terminals are being unmounted and remounted
//   nothing moving        -> structure is stable, so it is paint: CSS, an
//                            animation, or the compositor
//
// Kept pure, with no DOM and no Electron, for the same reason the eviction
// policy is (see terminal/lru.ts): the part worth testing is the judgement of
// what counts as a change, not the plumbing that collects it.

/** One sample of the things whose movement is visible as a flicker. */
export interface FlickerSnapshot {
  /** Milliseconds since the census started. */
  t: number
  /** <canvas> elements in the document — one per WebGL-accelerated terminal. */
  canvas: number
  /** Live xterm instances attached to the document. */
  xterms: number
  /** Session tiles rendered. */
  tiles: number
  /** Terminals holding a WebGL context, per the engine's own counter. */
  webgl: number
  /** Document visibility, 1 when visible. */
  visible: number
  /** Document focus, 1 when focused. */
  focus: number
  /**
   * Mounted terminals sitting in the alternate buffer, where there is no
   * scrollback to scroll and the wheel goes to the application instead. A pane
   * left here by a TUI that exited badly cannot be scrolled, and that looks
   * exactly like scrolling being broken.
   */
  altBuf: number
  /**
   * Decoration rows that would swallow wheel-scroll. xterm gives decorations
   * pointer-events:auto above the text and beside the scroll viewport, so each
   * one must be reset to 'none' on every render (see xterm-engine decorate()).
   * Any number above zero here is a pane the user cannot scroll over.
   */
  decorBlocking: number
}

/** The fields compared between samples. `t` is a timestamp, not a measurement. */
export const FLICKER_FIELDS = [
  'canvas',
  'xterms',
  'tiles',
  'webgl',
  'visible',
  'focus',
  'altBuf',
  'decorBlocking'
] as const

export type FlickerField = (typeof FLICKER_FIELDS)[number]

/** A field that moved between two consecutive samples. */
export interface FlickerChange {
  field: FlickerField
  from: number
  to: number
}

/** Changes between two samples, newest last. Empty when nothing moved. */
export interface FlickerDelta {
  t: number
  changes: FlickerChange[]
}

/**
 * What moved between two samples, or null when nothing did.
 *
 * Returning null is the point: a census that logs every tick buries the four
 * interesting lines under thousands of identical ones, and the interesting
 * lines are precisely the ones where something changed.
 */
export function diffSnapshots(
  prev: FlickerSnapshot,
  next: FlickerSnapshot
): FlickerDelta | null {
  const changes: FlickerChange[] = []
  for (const field of FLICKER_FIELDS) {
    if (prev[field] !== next[field]) {
      changes.push({ field, from: prev[field], to: next[field] })
    }
  }
  return changes.length ? { t: next.t, changes } : null
}

/**
 * How often each field moved across a capture.
 *
 * A single change is ordinary — opening a session mounts a terminal. A field
 * that moves dozens of times in a minute is the flicker, so the count is what
 * distinguishes the two, and reading one summary line beats reading the log.
 */
export function summarize(deltas: FlickerDelta[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const d of deltas) {
    for (const c of d.changes) counts[c.field] = (counts[c.field] ?? 0) + 1
  }
  return counts
}

/**
 * The field that moved most, or null when nothing moved at all.
 *
 * Ties resolve by FLICKER_FIELDS order, which runs from the most specific
 * suspect (canvas: a GPU context appearing and vanishing) to the least
 * (focus: something the user did), so a tie points at the narrower cause.
 */
export function dominantField(deltas: FlickerDelta[]): FlickerField | null {
  const counts = summarize(deltas)
  let best: FlickerField | null = null
  let bestCount = 0
  for (const field of FLICKER_FIELDS) {
    const n = counts[field] ?? 0
    if (n > bestCount) {
      best = field
      bestCount = n
    }
  }
  return best
}

/**
 * The plain-language reading of a capture, so the log says what it means
 * instead of leaving the next person to re-derive it from counters.
 */
export function interpret(deltas: FlickerDelta[]): string {
  const field = dominantField(deltas)
  if (!field) {
    return 'no structural change: the DOM held still, so the flicker is paint (CSS/animation/compositor), not mount or renderer churn'
  }
  const counts = summarize(deltas)
  const n = counts[field]
  switch (field) {
    case 'canvas':
    case 'webgl':
      return `${field} moved ${n}x: terminals are swapping between the WebGL and DOM renderers`
    case 'xterms':
    case 'tiles':
      return `${field} moved ${n}x: terminals are being unmounted and remounted`
    case 'visible':
    case 'focus':
      return `${field} moved ${n}x: the window is changing focus/visibility underneath the UI`
    case 'altBuf':
      return `${field} moved ${n}x: a terminal is entering/leaving the alternate buffer, where there is no scrollback to scroll`
    case 'decorBlocking':
      return `${field} moved ${n}x: decoration rows are taking pointer events, which swallows wheel-scroll over them`
  }
}
