import { describe, it, expect } from 'vitest'
import { createFitReporter, type Size } from '../src/renderer/terminal/fit-reporter'

/**
 * Regression: a narrow column of text inside a wide pane, with the agent's
 * status line stranded where the old edge used to be.
 *
 * A pane that fits itself during a transition reports a width that is wrong but
 * plausible, and nothing ever revisits it: the ResizeObserver fires when the
 * host's size CHANGES, and the host's size never changes again. So the PTY
 * keeps that width for the rest of the run.
 *
 * Crew now re-fits whenever the window comes to the front, which is a moment
 * when layout has certainly settled. That makes fits frequent, and a PTY resize
 * raises SIGWINCH, so the reporter forwards a size only when it differs from
 * the last one reported — otherwise every click back into Crew would redraw
 * every live agent.
 */
describe('fit reporter', () => {
  function harness(sizes: Array<Size | null>): {
    report: () => Size | null
    sent: Size[]
  } {
    const sent: Size[] = []
    let i = 0
    const reporter = createFitReporter(
      () => sizes[Math.min(i++, sizes.length - 1)],
      (cols, rows) => sent.push({ cols, rows })
    )
    return { report: () => reporter.report(), sent }
  }

  it('reports the first measurement', () => {
    const h = harness([{ cols: 213, rows: 50 }])
    h.report()
    expect(h.sent).toEqual([{ cols: 213, rows: 50 }])
  })

  it('stays silent while the size is unchanged', () => {
    const h = harness([{ cols: 213, rows: 50 }])
    for (let n = 0; n < 5; n++) h.report()
    // Five fits, one SIGWINCH. Without this, every window focus would redraw
    // every live agent.
    expect(h.sent).toEqual([{ cols: 213, rows: 50 }])
  })

  it('reports a corrected size after a pane was fitted at the wrong width', () => {
    const h = harness([
      { cols: 80, rows: 50 }, // measured mid-transition
      { cols: 213, rows: 50 } // re-fit once the window came to the front
    ])
    h.report()
    h.report()
    expect(h.sent).toEqual([
      { cols: 80, rows: 50 },
      { cols: 213, rows: 50 }
    ])
  })

  it('reports again when only the row count changes', () => {
    const h = harness([
      { cols: 213, rows: 50 },
      { cols: 213, rows: 44 }
    ])
    h.report()
    h.report()
    expect(h.sent).toHaveLength(2)
  })

  it('does not forget the reported size when a fit is unmeasurable', () => {
    const h = harness([
      { cols: 213, rows: 50 },
      null, // pane collapsed or mid-transition
      { cols: 213, rows: 50 }
    ])
    expect(h.report()).toEqual({ cols: 213, rows: 50 })
    expect(h.report()).toBeNull()
    h.report()
    // Treating "not measurable" as "no size reported" would raise a SIGWINCH
    // for a size the PTY is already at.
    expect(h.sent).toEqual([{ cols: 213, rows: 50 }])
  })
})
