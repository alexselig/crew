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
 * 2. A single fit pass does not converge. Measured: after a width collapse and
 *    restore, one pass settled the terminal at 129 columns while a fresh
 *    proposal on the same container said 125. Nothing re-fits after that, so
 *    the terminal stays wider than the box that shows it -- right-aligned
 *    output is drawn past the visible edge and a horizontal scrollbar appears.
 *    (This file used to blame FitAddon re-reading the viewport scrollbar width
 *    mid-call. That was wrong: xterm assigns `Viewport.scrollBarWidth` once, in
 *    its constructor, and never re-measures it. See `runFitLoop` below for the
 *    mechanism that does explain it.)
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

/** The subset of xterm's render-service dimensions the row clamp needs. */
export interface CellDimensions {
  device?: { cell?: { height?: number } }
  css?: { cell?: { height?: number } }
}

/**
 * A cell height that does not change when xterm swaps renderers, and does not
 * change with the row count.
 *
 * The row clamp divides by this, so anything that moves it can move the row
 * count for a container that never changed — and xterm's two renderers do NOT
 * agree on `css.cell.height`:
 *
 *   WebGL:  css.cell.height = device.cell.height / dpr
 *   DOM:    css.canvas.height = round(device.cell.height * rows / dpr)
 *           css.cell.height   = css.canvas.height / rows
 *
 * The DOM value is rounded at the canvas and then divided back out, so it is
 * both off by up to half a device pixel AND a function of the current row
 * count. Two separate defects follow.
 *
 * Across renderers: macOS drops every WebGL context when the window is
 * occluded, so clicking away swaps each visible pane to the DOM renderer and
 * clicking back swaps it to WebGL. The divisor therefore changed twice per
 * focus cycle while the pane itself sat still.
 *
 * Within the DOM renderer alone: because the value depends on the row count,
 * it can have no fixed point. At 412.8px of content with a 33px device cell at
 * dpr 2, the reading taken at 24 rows clamps to 25 and the reading taken at 25
 * rows clamps back to 24 — forever. Each flip resizes the PTY and the agent
 * redraws one row taller, then one row shorter: the text jitters up and down.
 *
 * `device.cell.height` is the quantity both renderers derive from, and it
 * depends on neither the renderer nor the row count, so dividing it by the
 * device pixel ratio gives the value WebGL already reports and the DOM
 * renderer is approximating. Falling back to `css.cell.height` keeps the old
 * behaviour if xterm's internals are ever reshaped.
 *
 * The caller's `dpr` is checked against the stored `css.cell.height` rather
 * than trusted, because the two operands come from different moments:
 * `device.cell.height` is written only when xterm recomputes dimensions, while
 * `window.devicePixelRatio` changes the instant the window moves to a display
 * with a different backing scale. Dividing a dpr-2 cell height by a dpr-1
 * ratio would be wrong by a factor of two, and that wrong row cap goes
 * straight to the PTY. The honest disagreement between the two readings is
 * only ever `0.5 / rows` CSS px — the DOM's rounding — so anything above half
 * a pixel means the snapshots do not belong together, and the internally
 * consistent `css.cell.height` is the safer answer. Imprecise beats doubled.
 *
 * Verified against @xterm/xterm 5.5.0, addon-fit 0.10.0, addon-webgl 0.18.0.
 */
export function stableCellHeightPx(dims: CellDimensions | null | undefined, dpr: number): number {
  const css = dims?.css?.cell?.height
  const cssPx = typeof css === 'number' && css > 0 ? css : 0
  const device = dims?.device?.cell?.height
  if (typeof device === 'number' && device > 0 && Number.isFinite(dpr) && dpr > 0) {
    const stable = device / dpr
    if (cssPx === 0 || Math.abs(stable - cssPx) <= 0.5) return stable
  }
  return cssPx
}

/** The size a fit settled on. */
export interface FitSize {
  cols: number
  rows: number
}

/** The part of a terminal the fit loop drives. */
export interface ResizableTerm {
  readonly cols: number
  readonly rows: number
  resize(cols: number, rows: number): void
}

/** How many proposals we will take before accepting the last one. */
export const FIT_MAX_PASSES = 3

/**
 * Drive a terminal to the size its mount implies, or return null and change
 * nothing.
 *
 * `decide` is called fresh each pass and must re-read the proposal, because
 * resizing the grid changes what FitAddon proposes next.
 *
 * Why iterate: one pass does not always land on a fixed point. After a width
 * collapse and restore, a pane measured 129 columns on the first proposal
 * while a fresh proposal on the same container said 125. (An earlier version
 * of this comment blamed FitAddon re-measuring the viewport scrollbar. That
 * is wrong: xterm assigns Viewport.scrollBarWidth once, in the constructor,
 * and never re-measures it, so it cannot move within a synchronous call. The
 * DOM renderer's rounding is the mechanism that actually moves a proposal
 * here, and it moves it by at most a cell.) Two passes reach the fixed point;
 * the third is a stop, not an expectation.
 *
 * Invariant: a null return means nothing was applied. Once a pass has resized
 * the grid, the loop reports that size rather than null -- otherwise the
 * caller would read "nothing changed" and leave the PTY on its old width
 * while the grid had already moved, and the shell would wrap to a width the
 * terminal no longer has. That cannot currently happen (`decide` returning a
 * size and then null within one call has no reachable input), so this is a
 * structural guarantee rather than a live bug fix -- which is exactly why it
 * is expressed as a `break` and not as an extra branch to maintain.
 */
export function runFitLoop(
  term: ResizableTerm,
  decide: () => FitSize | null,
  maxPasses: number = FIT_MAX_PASSES
): FitSize | null {
  let applied: FitSize | null = null
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = decide()
    if (!next) break
    applied = next
    if (term.cols === next.cols && term.rows === next.rows) break
    term.resize(next.cols, next.rows)
  }
  return applied
}
