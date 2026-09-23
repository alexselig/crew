/**
 * Deciding what terminal size to push to a PTY — and when to refuse.
 *
 * Kept DOM-free so it can be tested directly; the engine supplies the
 * measurements and applies the answer.
 *
 * Two defects motivate this, both reproduced against the real FitAddon:
 *
 * 1. A mount that collapses to zero produces a *plausible* size, not an
 *    obvious error. FitAddon's proposeDimensions() clamps with
 *    `Math.max(2, ...)` cols and `Math.max(1, ...)` rows, so a pane laid out
 *    at 0px height proposes 1 row and one at 0px width proposes 2 columns.
 *    Only `display: none` is safe, because that yields NaN from
 *    getComputedStyle and FitAddon discards it. Everything else -- a collapsed
 *    split, a pane mid-transition, a window being restored -- sails through
 *    and Crew forwards it to the live PTY. A TUI told it has one row redraws
 *    its entire interface into that row, and the damage outlives the moment:
 *    the agent keeps drawing to a geometry that no longer exists, which is how
 *    a status line ends up stranded in the middle of a pane.
 *
 * 2. A single fit pass does not converge. FitAddon subtracts the viewport
 *    scrollbar width, but the scrollbar's existence depends on the size being
 *    proposed, so the value read during a collapsed frame is stale. Measured:
 *    after a width collapse and restore, one pass settled the terminal at 129
 *    columns while a fresh proposal on the same container said 125. Nothing
 *    re-fits after that, so the terminal stays wider than the box that shows
 *    it -- right-aligned output is drawn past the visible edge and a
 *    horizontal scrollbar appears.
 */

/**
 * FitAddon's own floors. Reaching one means the container had less than one
 * cell of room, i.e. it was not laid out -- no real pane is two columns wide.
 */
export const FIT_FLOOR_COLS = 2
export const FIT_FLOOR_ROWS = 1

export interface HostBox {
  /** Whether the mount is still in the document. */
  connected: boolean
  clientWidth: number
  clientHeight: number
}

export interface FitInputs {
  /** What FitAddon proposed, or undefined when it declined to guess. */
  proposed: { cols: number; rows: number } | undefined
  host: HostBox | null
  /** The mount's true content height, used to stop the bottom row clipping. */
  contentHeightPx: number
  cellHeightPx: number
}

/**
 * A mount nobody can see has no meaningful size, and resizing a PTY to match
 * it corrupts a session the user is not even looking at.
 */
export function isLaidOut(host: HostBox | null): boolean {
  if (!host || !host.connected) return false
  return host.clientWidth > 0 && host.clientHeight > 0
}

/** Reject FitAddon's clamp floors and anything non-finite. */
export function isUsableSize(cols: number, rows: number): boolean {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false
  return cols > FIT_FLOOR_COLS && rows > FIT_FLOOR_ROWS
}

/**
 * The size to apply, or null to leave the terminal (and the PTY) alone.
 *
 * Returning null is the important case: it means "this measurement is not
 * trustworthy", and the correct response is to keep the last good size rather
 * than to guess. The ResizeObserver fires again when the mount regains a real
 * size, so refusing here costs nothing.
 */
export function decideFit(input: FitInputs): { cols: number; rows: number } | null {
  if (!isLaidOut(input.host)) return null
  const p = input.proposed
  if (!p || !isUsableSize(p.cols, p.rows)) return null

  let rows = p.rows
  // FitAddon measures padding on the .xterm element, but Crew's padding lives
  // on the parent mount (border-box), so it proposes one row too many and the
  // bottom row -- the input prompt and footer -- gets clipped.
  if (input.cellHeightPx > 0 && input.contentHeightPx > 0) {
    const maxRows = Math.floor(input.contentHeightPx / input.cellHeightPx)
    // Too short to show a single row: the mount is collapsing, not small.
    if (maxRows < 1) return null
    rows = Math.min(rows, maxRows)
  }
  if (!isUsableSize(p.cols, rows)) return null
  return { cols: p.cols, rows }
}
