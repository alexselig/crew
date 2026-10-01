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
 * Crew now re-fits whenever the window comes to the front or a pane's own
 * layout transition ends, both moments when layout has settled. That makes fits
 * frequent, so the reporter forwards a size only when it differs from the last
 * one reported, keeping the IPC chatter proportionate to the news.
 */
describe('fit reporter', () => {
  function harness(sizes: Array<Size | null>): {
    report: () => Size | null
    sent: Size[]
  } {
    const sent: Size[] = []
    let i = 0
    const reporter = createFitReporter(
      () => {
        const s = sizes[Math.min(i++, sizes.length - 1)]
        // engine.fit() builds a fresh object every call, so the reporter has to
        // compare by value. Handing out a copy is what makes these tests able
        // to fail: against a reference comparison they would all pass here and
        // the reporter would then send on every fit in production.
        return s && { ...s }
      },
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
    // Five fits, one message. This is the behaviour the whole module exists
    // for, and the one a reference comparison would silently break.
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
    // Treating "not measurable" as "no size reported" would send a size the
    // PTY is already at.
    expect(h.sent).toEqual([{ cols: 213, rows: 50 }])
  })

  it('says nothing at all while the pane has never been measurable', () => {
    const h = harness([null])
    for (let n = 0; n < 3; n++) expect(h.report()).toBeNull()
    expect(h.sent).toEqual([])
  })

  it('reports a size again after the pane has been some other size in between', () => {
    const h = harness([
      { cols: 213, rows: 50 },
      { cols: 106, rows: 50 }, // grid split in two
      { cols: 213, rows: 50 } // and back
    ])
    h.report()
    h.report()
    h.report()
    // The reporter holds the LAST size, not the set of sizes it has seen: the
    // PTY is at 106 by the third call, so 213 is news again.
    expect(h.sent).toEqual([
      { cols: 213, rows: 50 },
      { cols: 106, rows: 50 },
      { cols: 213, rows: 50 }
    ])
  })
})
