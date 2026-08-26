// Which pooled terminals to retire when the pool outgrows its cap.
//
// A terminal emulator is not free: every live instance owns a scrollback grid,
// a DOM subtree, and (when visible) a GPU context. Crew pools one per session
// so scrollback survives tab switches — fine at ten sessions, fatal at sixty.
// A large roster of *background* agents streams output continuously (spinners,
// progress bars, TUI repaints), so every pooled terminal keeps parsing and
// buffering forever even though nobody is looking at it. That is what pushed
// the renderer past its address space and made Blink abort with
// "Oilpan: Large allocation ... out of memory" — and a renderer that keeps
// dying and reloading is exactly what a user sees as flicker.
//
// So the pool is bounded. This module owns only the *choice* of what to retire,
// kept pure so the policy can be tested without a DOM, an engine, or xterm.
//
// Two rules, both load-bearing:
//   1. A mounted terminal is never retired — it is on screen right now.
//   2. Among the rest, retire least-recently-*viewed* first. Recency means the
//      last time a human looked at the session, NOT the last time it produced
//      output: background agents write constantly, so an output-driven LRU
//      would rank a noisy unseen session above one the user just left.

export interface LruEntry {
  id: string
  /** When a human last had this terminal on screen (ms epoch). */
  lastUsed: number
  /** True while the terminal is attached to the DOM. Never retired. */
  mounted: boolean
}

/**
 * Ids to retire so at most `cap` terminals stay live, least-recently-viewed
 * first. Returns fewer than needed (possibly none) when too many are mounted —
 * retiring a visible terminal would blank a pane the user is watching, so the
 * cap yields to what is on screen.
 */
export function selectEvictions(entries: LruEntry[], cap: number): string[] {
  const over = entries.length - Math.max(0, cap)
  if (over <= 0) return []
  return entries
    .filter((e) => !e.mounted)
    .sort((a, b) => a.lastUsed - b.lastUsed || (a.id < b.id ? -1 : 1))
    .slice(0, over)
    .map((e) => e.id)
}
