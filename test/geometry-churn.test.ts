import { describe, it, expect } from 'vitest'
import {
  createChurnAccumulator,
  dominantWobble,
  interpretChurn,
  GEOMETRY_FIELDS,
  type GeometrySample
} from '../src/shared/geometry-churn'

const base: GeometrySample = {
  canvasW: 1600,
  canvasH: 900,
  screenW: 800,
  screenH: 450,
  scrollTop: 0,
  winW: 1440,
  winH: 900,
  dpr: 200
}

const s = (over: Partial<GeometrySample> = {}): GeometrySample => ({ ...base, ...over })

describe('geometry churn accumulator', () => {
  it('counts nothing when every frame is identical', () => {
    const a = createChurnAccumulator()
    for (let i = 0; i < 10; i++) a.add(s())
    const r = a.report()
    expect(r.frames).toBe(10)
    expect(GEOMETRY_FIELDS.every((f) => r.changes[f] === 0)).toBe(true)
  })

  it('does not count the first sample as a change', () => {
    const a = createChurnAccumulator()
    a.add(s())
    expect(a.report().changes.canvasW).toBe(0)
  })

  it('counts a one-way resize once', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ winW: 1200 }))
    a.add(s({ winW: 1200 }))
    a.add(s({ winW: 1200 }))
    const r = a.report()
    expect(r.changes.winW).toBe(1)
    expect(r.oscillations.winW).toBe(0)
  })

  it('counts a wobble as an oscillation, not just a change', () => {
    const a = createChurnAccumulator()
    a.add(s({ canvasH: 900 }))
    a.add(s({ canvasH: 901 }))
    a.add(s({ canvasH: 900 }))
    a.add(s({ canvasH: 901 }))
    a.add(s({ canvasH: 900 }))
    const r = a.report()
    expect(r.changes.canvasH).toBe(4)
    expect(r.oscillations.canvasH).toBe(3)
  })

  it('separates a resize from a wobble on the same capture', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ winW: 1200, scrollTop: 10 }))
    a.add(s({ winW: 1200, scrollTop: 0 }))
    a.add(s({ winW: 1200, scrollTop: 10 }))
    const r = a.report()
    expect(r.oscillations.winW).toBe(0)
    expect(r.oscillations.scrollTop).toBe(2)
  })

  it('tracks each field independently', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ canvasW: 1601 }))
    a.add(s({ canvasW: 1600 }))
    const r = a.report()
    expect(r.oscillations.canvasW).toBe(1)
    expect(r.oscillations.canvasH).toBe(0)
  })

  it('zeroes counts on reset but keeps diffing across it', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ scrollTop: 5 }))
    a.reset()
    expect(a.report().frames).toBe(0)
    expect(a.report().changes.scrollTop).toBe(0)
    // The value before the reset is still remembered, so this reads as a change.
    a.add(s({ scrollTop: 9 }))
    expect(a.report().changes.scrollTop).toBe(1)
  })

  it('reports a copy, so a later frame cannot mutate a captured report', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ winH: 800 }))
    const snapshot = a.report()
    a.add(s({ winH: 700 }))
    expect(snapshot.changes.winH).toBe(1)
  })
})

describe('dominantWobble', () => {
  it('returns null when nothing oscillated', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ winW: 1200 }))
    expect(dominantWobble(a.report())).toBeNull()
  })

  it('picks the field that wobbled most', () => {
    const a = createChurnAccumulator()
    a.add(s())
    for (let i = 0; i < 6; i++) a.add(s({ canvasH: i % 2 ? 901 : 900, scrollTop: i < 3 ? 0 : 1 }))
    expect(dominantWobble(a.report())).toBe('canvasH')
  })
})

describe('interpretChurn', () => {
  it('names paint when geometry never moved at all', () => {
    const a = createChurnAccumulator()
    for (let i = 0; i < 120; i++) a.add(s())
    expect(interpretChurn(a.report())).toMatch(/held still across 120 frames/)
    expect(interpretChurn(a.report())).toMatch(/paint inside a stable box/)
  })

  it('calls a one-way move what it is', () => {
    const a = createChurnAccumulator()
    a.add(s())
    a.add(s({ winW: 1200 }))
    expect(interpretChurn(a.report())).toMatch(/one-way resize, not a wobble/)
  })

  it('points at the fit loop when the canvas wobbles', () => {
    const a = createChurnAccumulator()
    a.add(s())
    for (let i = 0; i < 8; i++) a.add(s({ canvasH: i % 2 ? 901 : 900 }))
    const text = interpretChurn(a.report())
    expect(text).toMatch(/canvasH wobbled/)
    expect(text).toMatch(/fit loop is fighting itself/)
  })

  it('points at scroll when the viewport snaps back', () => {
    const a = createChurnAccumulator()
    a.add(s())
    for (let i = 0; i < 8; i++) a.add(s({ scrollTop: i % 2 ? 40 : 0 }))
    expect(interpretChurn(a.report())).toMatch(/scrolling and snapping back/)
  })

  it('reports a per-frame rate so a slow move reads differently from jitter', () => {
    const a = createChurnAccumulator()
    a.add(s())
    for (let i = 0; i < 9; i++) a.add(s({ canvasW: i % 2 ? 1601 : 1600 }))
    expect(interpretChurn(a.report())).toMatch(/\(0\.\d\d\/frame\)/)
  })
})
