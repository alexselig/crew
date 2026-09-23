import { describe, it, expect } from 'vitest'
import { decideFit, isLaidOut, isUsableSize } from '../src/renderer/terminal/fit-guard'

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
