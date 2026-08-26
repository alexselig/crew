import { describe, it, expect } from 'vitest'
import { rations } from '../scripts/handoff.mjs'

// The brief quotes the closing exchanges of a conversation. How the character
// budget is split across those turns is what decides whether a successor reads
// something useful or a row of ellipses, so the shape is pinned here.
describe('turn rationing', () => {
  it('gives the newest turn the largest share', () => {
    const r = rations(6, 14000)
    expect(r[0]).toBeGreaterThan(r[1])
    expect(r[1]).toBeGreaterThan(r[2])
  })

  it('stays within the total budget', () => {
    const r = rations(6, 14000)
    expect(r.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(14000)
  })

  it('never clips a turn below a readable floor', () => {
    // 40 turns over the same budget would flat-ration to 350 characters each and
    // decay-ration the oldest to nearly nothing; the floor is what keeps the
    // tail of the window quotable at all.
    const r = rations(40, 14000)
    expect(Math.min(...r)).toBeGreaterThanOrEqual(320)
  })

  it('caps a single turn so one long message cannot eat the section', () => {
    const r = rations(1, 100000)
    expect(r[0]).toBeLessThanOrEqual(5000)
  })

  it('handles a single turn', () => {
    expect(rations(1, 14000)).toHaveLength(1)
  })

  it('handles no turns', () => {
    expect(rations(0, 14000)).toEqual([])
  })
})
