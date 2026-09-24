import { describe, it, expect } from 'vitest'
import { isDeliberateReveal, revealInline, revealKey } from '../src/renderer/reveal'

describe('reveal alignment', () => {
  it('aligns a navigated session to the left edge', () => {
    expect(revealInline('a3', { id: 'a3', seq: 1 })).toBe('start')
    expect(isDeliberateReveal('a3', { id: 'a3', seq: 1 })).toBe(true)
  })

  it('moves as little as possible for a bare selection', () => {
    // Clicking a tile records no request, so the layout must not jump under the
    // cursor: the tile is already visible and should stay where it is.
    expect(revealInline('a3', null)).toBe('nearest')
    expect(isDeliberateReveal('a3', null)).toBe(false)
  })

  it('does not left-align a session that is not the one navigated to', () => {
    // A navigation to a3 followed by clicking a7's tile: the stale request must
    // not drag a7 to the left edge.
    expect(revealInline('a7', { id: 'a3', seq: 4 })).toBe('nearest')
  })

  it('has nothing to reveal without a selection', () => {
    expect(isDeliberateReveal(null, { id: 'a3', seq: 1 })).toBe(false)
    expect(revealInline(null, { id: 'a3', seq: 1 })).toBe('nearest')
  })

  it('re-aligns when navigating to the already-selected session', () => {
    // Same id, later sequence: the effect key must change so clicking the same
    // nav row twice scrolls it back to the left edge the second time.
    expect(revealKey('a3', { id: 'a3', seq: 1 })).toBe(1)
    expect(revealKey('a3', { id: 'a3', seq: 2 })).toBe(2)
  })

  it('collapses to no key when the request is not for the selected session', () => {
    // Otherwise navigating elsewhere would bump this session's effect key and
    // re-scroll a session the user did not ask for.
    expect(revealKey('a7', { id: 'a3', seq: 9 })).toBeNull()
    expect(revealKey('a7', null)).toBeNull()
    expect(revealKey(null, { id: 'a3', seq: 9 })).toBeNull()
  })

  it('treats an undefined request the same as an absent one', () => {
    expect(revealInline('a3', undefined)).toBe('nearest')
    expect(revealKey('a3', undefined)).toBeNull()
  })
})
