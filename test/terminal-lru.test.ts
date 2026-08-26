import { describe, it, expect } from 'vitest'
import { selectEvictions, type LruEntry } from '../src/renderer/terminal/lru'

const e = (id: string, lastUsed: number, mounted = false): LruEntry => ({ id, lastUsed, mounted })

describe('terminal pool retirement policy', () => {
  it('retires nothing while the pool is within its cap', () => {
    expect(selectEvictions([e('a', 1), e('b', 2)], 2)).toEqual([])
    expect(selectEvictions([e('a', 1)], 12)).toEqual([])
    expect(selectEvictions([], 12)).toEqual([])
  })

  it('retires exactly the overflow, least-recently-viewed first', () => {
    const entries = [e('new', 300), e('old', 100), e('mid', 200)]
    expect(selectEvictions(entries, 2)).toEqual(['old'])
    expect(selectEvictions(entries, 1)).toEqual(['old', 'mid'])
  })

  it('never retires a mounted terminal, even the least recently viewed', () => {
    // 'visible' is the oldest by view time but is on screen right now; retiring
    // it would blank a pane the user is watching.
    const entries = [e('visible', 1, true), e('bg1', 500), e('bg2', 600)]
    expect(selectEvictions(entries, 2)).toEqual(['bg1'])
  })

  it('yields to the screen: returns fewer than the overflow when most are mounted', () => {
    const entries = [e('m1', 1, true), e('m2', 2, true), e('m3', 3, true), e('bg', 4)]
    // Three over cap, but only one terminal is retirable.
    expect(selectEvictions(entries, 1)).toEqual(['bg'])
  })

  it('is deterministic when view times tie', () => {
    const entries = [e('b', 7), e('a', 7), e('c', 7)]
    expect(selectEvictions(entries, 1)).toEqual(['a', 'b'])
  })

  it('treats a non-positive cap as "retire every unmounted terminal"', () => {
    const entries = [e('a', 1), e('b', 2, true)]
    expect(selectEvictions(entries, 0)).toEqual(['a'])
  })
})
