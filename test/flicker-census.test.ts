import { describe, it, expect } from 'vitest'
import {
  diffSnapshots,
  summarize,
  dominantField,
  interpret,
  FLICKER_FIELDS,
  type FlickerSnapshot,
  type FlickerDelta
} from '../src/shared/flicker-census'

const snap = (over: Partial<FlickerSnapshot> = {}): FlickerSnapshot => ({
  t: 0,
  canvas: 4,
  xterms: 4,
  tiles: 4,
  webgl: 4,
  visible: 1,
  focus: 1,
  altBuf: 0,
  decorBlocking: 0,
  ...over
})

describe('flicker census: what moved', () => {
  it('reports nothing when the window held still', () => {
    expect(diffSnapshots(snap(), snap({ t: 250 }))).toBeNull()
  })

  it('ignores the timestamp, which always moves and means nothing', () => {
    // t is how we order samples, not something whose movement is a symptom.
    // If it counted, every single tick would log and the signal would vanish.
    expect(FLICKER_FIELDS).not.toContain('t')
    expect(diffSnapshots(snap({ t: 0 }), snap({ t: 99_999 }))).toBeNull()
  })

  it('names the field that moved, with both values', () => {
    const d = diffSnapshots(snap({ canvas: 4 }), snap({ t: 250, canvas: 3 }))
    expect(d).toEqual({ t: 250, changes: [{ field: 'canvas', from: 4, to: 3 }] })
  })

  it('reports every field that moved in the same tick', () => {
    const d = diffSnapshots(snap(), snap({ t: 250, canvas: 3, xterms: 3, focus: 0 }))
    expect(d?.changes.map((c) => c.field)).toEqual(['canvas', 'xterms', 'focus'])
  })

  it('counts a value that returns to where it started as two changes', () => {
    // This is the shape of a flicker: gone, then back. Treating the round trip
    // as "no net change" would report a steady state and hide the symptom.
    const a = snap({ t: 0, canvas: 4 })
    const b = snap({ t: 250, canvas: 3 })
    const c = snap({ t: 500, canvas: 4 })
    const deltas = [diffSnapshots(a, b), diffSnapshots(b, c)].filter(Boolean) as FlickerDelta[]
    expect(deltas).toHaveLength(2)
    expect(summarize(deltas)).toEqual({ canvas: 2 })
  })
})

describe('flicker census: reading the capture', () => {
  const flapping = (field: 'canvas' | 'xterms', times: number): FlickerDelta[] =>
    Array.from({ length: times }, (_, i) => ({
      t: i * 250,
      changes: [{ field, from: i % 2 ? 3 : 4, to: i % 2 ? 4 : 3 }]
    }))

  it('summarizes how often each field moved', () => {
    expect(summarize(flapping('canvas', 7))).toEqual({ canvas: 7 })
  })

  it('picks the field that moved most as the suspect', () => {
    const deltas = [...flapping('xterms', 9), ...flapping('canvas', 2)]
    expect(dominantField(deltas)).toBe('xterms')
  })

  it('has no suspect when nothing moved', () => {
    expect(dominantField([])).toBeNull()
  })

  it('blames paint when the structure never moved — the case no shipped fix addresses', () => {
    // Five fixes targeted structure (WebGL contexts, mounts, reordering,
    // renderer death). If a capture taken during a visible flicker shows no
    // structural movement at all, every one of them was aimed at the wrong
    // layer, and this sentence is the finding.
    expect(interpret([])).toContain('paint')
    expect(interpret([])).toContain('not mount or renderer churn')
  })

  it('blames the renderer swap when canvases come and go', () => {
    expect(interpret(flapping('canvas', 12))).toContain('WebGL and DOM renderers')
  })

  it('blames remounting when terminals come and go', () => {
    expect(interpret(flapping('xterms', 12))).toContain('unmounted and remounted')
  })

  it('reports the count in its reading, so one line carries the evidence', () => {
    expect(interpret(flapping('canvas', 12))).toContain('12x')
  })
})

describe('scroll diagnostics', () => {
  it('reports a pane entering the alternate buffer, where there is nothing to scroll', () => {
    const d = diffSnapshots(snap(), snap({ altBuf: 1 }))
    expect(d).not.toBeNull()
    expect(d!.changes.map((c) => c.field)).toEqual(['altBuf'])
    expect(interpret([d!])).toContain('alternate buffer')
  })

  it('reports decoration rows that would swallow wheel-scroll', () => {
    const d = diffSnapshots(snap(), snap({ decorBlocking: 3 }))
    expect(d!.changes.map((c) => c.field)).toEqual(['decorBlocking'])
    expect(interpret([d!])).toContain('wheel-scroll')
  })

  it('stays silent when decorations are correctly transparent to the pointer', () => {
    expect(diffSnapshots(snap({ decorBlocking: 0 }), snap({ decorBlocking: 0 }))).toBeNull()
  })

  it('treats a decoration leak as the dominant signal when nothing else moves', () => {
    const d = diffSnapshots(snap(), snap({ decorBlocking: 7 }))!
    expect(dominantField([d])).toBe('decorBlocking')
  })
})
