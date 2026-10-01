import { describe, it, expect } from 'vitest'
import { decideFit, isLaidOut, isUsableSize, stableCellHeightPx } from '../src/renderer/terminal/fit-guard'

/**
 * Regression: a terminal's status line drawn in the wrong place, a horizontal
 * scrollbar on a pane that should not have one, and panes that go blank.
 *
 * Crew fitted the terminal on every ResizeObserver callback and forwarded the
 * result straight to the PTY. A mount that is laid out at zero -- a collapsed
 * split, a pane mid-transition, a window being restored -- does not fail
 * loudly: FitAddon clamps its proposal to 2 columns / 1 row and returns it
 * like any other answer. The PTY was then resized to that, and the agent
 * redrew its whole interface for a terminal one row tall.
 *
 * The numbers below are not invented. They were measured by driving the real
 * @xterm/addon-fit in a browser against a 920x420 mount:
 *
 *   normal layout          -> 125 x 24
 *   mount height set to 0  -> 125 x 1     <- forwarded to the PTY
 *   mount width set to 0   ->   2 x 24    <- forwarded to the PTY
 *   width restored         -> 129 x 24    <- while a fresh proposal said 125
 */
const CELL_H = 17
const HOST = { connected: true, clientWidth: 920, clientHeight: 420 }

describe('fit guard', () => {
  it('accepts a normally laid-out pane unchanged', () => {
    expect(
      decideFit({
        proposed: { cols: 125, rows: 24 },
        host: HOST,
        contentHeightPx: 408,
        cellHeightPx: CELL_H
      })
    ).toEqual({ cols: 125, rows: 24 })
  })

  it('refuses the 1-row proposal a zero-height mount produces', () => {
    // The mount is still connected and still has width; only height collapsed.
    expect(
      decideFit({
        proposed: { cols: 125, rows: 1 },
        host: { connected: true, clientWidth: 920, clientHeight: 0 },
        contentHeightPx: 0,
        cellHeightPx: CELL_H
      })
    ).toBeNull()
  })

  it('refuses the 2-column proposal a zero-width mount produces', () => {
    expect(
      decideFit({
        proposed: { cols: 2, rows: 24 },
        host: { connected: true, clientWidth: 0, clientHeight: 420 },
        contentHeightPx: 408,
        cellHeightPx: CELL_H
      })
    ).toBeNull()
  })

  it('refuses to resize a mount that has been detached from the document', () => {
    expect(
      decideFit({
        proposed: { cols: 125, rows: 24 },
        host: { connected: false, clientWidth: 920, clientHeight: 420 },
        contentHeightPx: 408,
        cellHeightPx: CELL_H
      })
    ).toBeNull()
  })

  it('refuses when FitAddon declines to propose at all', () => {
    expect(
      decideFit({
        proposed: undefined,
        host: HOST,
        contentHeightPx: 408,
        cellHeightPx: CELL_H
      })
    ).toBeNull()
  })

  it('still caps rows to the mount so the input prompt is not clipped', () => {
    // FitAddon measures padding on .xterm, Crew's padding is on the parent, so
    // it proposes one row too many. That cap must survive the new guard.
    const out = decideFit({
      proposed: { cols: 125, rows: 25 },
      host: HOST,
      contentHeightPx: 408, // 408/17 = 24 rows
      cellHeightPx: CELL_H
    })
    expect(out).toEqual({ cols: 125, rows: 24 })
  })

  it('does not let the row cap itself produce a degenerate size', () => {
    // A sliver of height must be refused, not rounded down to one row.
    expect(
      decideFit({
        proposed: { cols: 125, rows: 24 },
        host: { connected: true, clientWidth: 920, clientHeight: 10 },
        contentHeightPx: 10,
        cellHeightPx: CELL_H
      })
    ).toBeNull()
  })

  it('treats FitAddon clamp floors as unusable', () => {
    expect(isUsableSize(2, 24)).toBe(false)
    expect(isUsableSize(125, 1)).toBe(false)
    expect(isUsableSize(3, 2)).toBe(true)
    expect(isUsableSize(NaN, 24)).toBe(false)
    expect(isUsableSize(125, NaN)).toBe(false)
  })

  it('treats a zero-size or detached host as not laid out', () => {
    expect(isLaidOut(null)).toBe(false)
    expect(isLaidOut({ connected: true, clientWidth: 0, clientHeight: 420 })).toBe(false)
    expect(isLaidOut({ connected: true, clientWidth: 920, clientHeight: 0 })).toBe(false)
    expect(isLaidOut({ connected: false, clientWidth: 920, clientHeight: 420 })).toBe(false)
    expect(isLaidOut({ connected: true, clientWidth: 920, clientHeight: 420 })).toBe(true)
  })
})

/**
 * Regression: terminal text jumping one row up and then back down every time
 * the user clicks away from Crew and returns, in every visible pane at once.
 *
 * macOS drops every WebGL context when the window is occluded, so clicking
 * away swaps each visible pane to xterm's DOM renderer and clicking back swaps
 * it to WebGL. The two renderers do not compute `css.cell.height` the same way
 * (see stableCellHeightPx) -- the DOM one rounds at the canvas and divides by
 * the row count -- so the clamp's divisor moved twice per focus cycle while
 * the pane itself never changed size.
 *
 * domCss/webglCss below transcribe xterm's own formulas (verified against
 * @xterm/xterm 5.5.0 and @xterm/addon-webgl 0.18.0), not fit-guard's code, so
 * these assert an outcome rather than restate the implementation. If an xterm
 * upgrade changes those formulas, re-derive them here -- these tests would
 * otherwise stay green while the production bug returned.
 *
 * Note the mechanism needs an ODD device cell height at dpr 2: when
 * device.cell.height * rows is divisible by dpr the rounding is the identity,
 * the two renderers agree exactly, and none of this can happen.
 */
describe('fit guard — cell height is stable across renderer swaps', () => {
  const DEVICE_CELL_H = 33
  const DPR = 2
  const webglCss = DEVICE_CELL_H / DPR
  const domCss = (rows: number): number => Math.round((DEVICE_CELL_H * rows) / DPR) / rows

  it('reports the same height whichever renderer is live', () => {
    const webgl = stableCellHeightPx({ device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: webglCss } } }, DPR)
    const dom = stableCellHeightPx({ device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: domCss(25) } } }, DPR)
    expect(webgl).toBe(dom)
  })

  it('does not depend on the current row count, as the DOM css value does', () => {
    const at24 = stableCellHeightPx({ device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: domCss(24) } } }, DPR)
    const at25 = stableCellHeightPx({ device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: domCss(25) } } }, DPR)
    expect(domCss(24)).not.toBe(domCss(25)) // the instability being removed
    expect(at24).toBe(at25)
  })

  it('yields one row count for a pane that did not change size', () => {
    // 347px: an INTEGER height, because contentHeightPx is derived from
    // clientHeight minus whole-pixel padding and is integral in practice. The
    // DOM renderer's reading at 20 rows floors to 21, and its reading at 21
    // rows floors back to 20. So the raw css value does not merely disagree
    // across a renderer swap -- it has no fixed point within the DOM renderer
    // alone, and the clamp flips forever for a pane sitting perfectly still.
    const contentHeightPx = 347
    const rowsFrom = (cellHeightPx: number): number | null =>
      decideFit({ proposed: { cols: 125, rows: 40 }, host: HOST, contentHeightPx, cellHeightPx })?.rows ?? null

    expect(rowsFrom(webglCss)).toBe(21)
    expect(rowsFrom(domCss(21))).toBe(20)
    expect(rowsFrom(domCss(20))).toBe(21)

    const stable = (rows: number): number | null =>
      rowsFrom(stableCellHeightPx({ device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: domCss(rows) } } }, DPR))
    expect(stable(20)).toBe(21)
    expect(stable(21)).toBe(21)
  })

  it('falls back to the css value when xterm exposes no device cell height', () => {
    expect(stableCellHeightPx({ css: { cell: { height: 17 } } }, 2)).toBe(17)
    expect(stableCellHeightPx({ device: { cell: { height: 34 } } }, 0)).toBe(0)
    expect(stableCellHeightPx(null, 2)).toBe(0)
  })

  it('refuses a dpr that does not belong to the stored device cell height', () => {
    // device.cell.height is only rewritten when xterm recomputes dimensions,
    // but window.devicePixelRatio changes the moment the window moves to a
    // display with a different backing scale. Dividing a dpr-2 cell height by
    // a dpr-1 ratio would hand the PTY a row cap wrong by a factor of two.
    const dims = { device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: webglCss } } }
    expect(stableCellHeightPx(dims, DPR)).toBe(webglCss)
    expect(stableCellHeightPx(dims, 1)).toBe(webglCss) // not 33
    expect(stableCellHeightPx(dims, 4)).toBe(webglCss) // not 8.25
  })

  it('still prefers the device reading over the DOM rounding it is meant to replace', () => {
    // The honest disagreement is only the DOM's rounding, under half a pixel,
    // so the consistency check above must not reject the very case this exists
    // to fix.
    const dims = { device: { cell: { height: DEVICE_CELL_H } }, css: { cell: { height: domCss(21) } } }
    expect(domCss(21)).not.toBe(webglCss)
    expect(stableCellHeightPx(dims, DPR)).toBe(webglCss)
  })
})
