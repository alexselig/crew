import { describe, expect, it } from 'vitest'
import { runFitLoop, FIT_MAX_PASSES } from '../src/renderer/terminal/fit-guard'

/** Records resizes and reports the size it was last driven to, like xterm. */
function fakeTerm(cols = 80, rows = 24) {
  const resizes: Array<{ cols: number; rows: number }> = []
  return {
    cols,
    rows,
    resizes,
    resize(c: number, r: number) {
      resizes.push({ cols: c, rows: r })
      this.cols = c
      this.rows = r
    }
  }
}

/** Replays a scripted sequence of decisions, one per pass. */
function script(...decisions: Array<{ cols: number; rows: number } | null>) {
  let i = 0
  const calls = () => i
  return { next: () => decisions[Math.min(i++, decisions.length - 1)] ?? null, calls }
}

describe('runFitLoop', () => {
  it('applies a decision that differs from the current size', () => {
    const term = fakeTerm(80, 24)
    const s = script({ cols: 125, rows: 30 }, { cols: 125, rows: 30 })
    expect(runFitLoop(term, s.next)).toEqual({ cols: 125, rows: 30 })
    expect(term.resizes).toEqual([{ cols: 125, rows: 30 }])
  })

  it('converges when the first proposal is stale', () => {
    // The measured case: 129 columns on the first proposal, 125 on a fresh one.
    const term = fakeTerm(80, 24)
    const s = script({ cols: 129, rows: 30 }, { cols: 125, rows: 30 }, { cols: 125, rows: 30 })
    expect(runFitLoop(term, s.next)).toEqual({ cols: 125, rows: 30 })
    expect(term.resizes).toEqual([
      { cols: 129, rows: 30 },
      { cols: 125, rows: 30 }
    ])
  })

  it('stops as soon as the decision matches the current size', () => {
    const term = fakeTerm(80, 24)
    const s = script({ cols: 80, rows: 24 })
    expect(runFitLoop(term, s.next)).toEqual({ cols: 80, rows: 24 })
    expect(term.resizes).toEqual([])
    expect(s.calls()).toBe(1)
  })

  it('returns null and resizes nothing when the first decision refuses', () => {
    const term = fakeTerm(80, 24)
    expect(runFitLoop(term, () => null)).toBeNull()
    expect(term.resizes).toEqual([])
  })

  it('never reports null once a resize has been applied', () => {
    // Guards the invariant: a null return means "nothing changed", so a caller
    // that saw one would leave the PTY on a width the grid no longer has.
    const term = fakeTerm(80, 24)
    const s = script({ cols: 125, rows: 30 }, null)
    expect(runFitLoop(term, s.next)).toEqual({ cols: 125, rows: 30 })
    expect(term.resizes).toEqual([{ cols: 125, rows: 30 }])
  })

  it('takes no more than FIT_MAX_PASSES proposals', () => {
    const term = fakeTerm(80, 24)
    let n = 0
    // Never settles: each pass proposes something new.
    runFitLoop(term, () => {
      n += 1
      return { cols: 100 + n, rows: 30 }
    })
    expect(n).toBe(FIT_MAX_PASSES)
    expect(term.resizes).toHaveLength(FIT_MAX_PASSES)
  })
})
