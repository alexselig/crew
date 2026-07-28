import { describe, it, expect } from 'vitest'
import { pickJumpTarget } from '../src/shared/nav'

describe('pickJumpTarget', () => {
  const lines = [2, 10, 25, 40]

  it('returns null with no landmarks', () => {
    expect(pickJumpTarget([], 5, 'next')).toBeNull()
    expect(pickJumpTarget([], 5, 'prev')).toBeNull()
  })

  it('finds the next landmark strictly below the viewport top', () => {
    expect(pickJumpTarget(lines, 5, 'next')).toBe(10)
    expect(pickJumpTarget(lines, 10, 'next')).toBe(25)
    expect(pickJumpTarget(lines, 25, 'next')).toBe(40)
  })

  it('returns null when already at/after the last landmark going next', () => {
    expect(pickJumpTarget(lines, 40, 'next')).toBeNull()
    expect(pickJumpTarget(lines, 100, 'next')).toBeNull()
  })

  it('finds the previous landmark strictly above the viewport top', () => {
    expect(pickJumpTarget(lines, 40, 'prev')).toBe(25)
    expect(pickJumpTarget(lines, 25, 'prev')).toBe(10)
    expect(pickJumpTarget(lines, 10, 'prev')).toBe(2)
  })

  it('returns null when already at/above the first landmark going prev', () => {
    expect(pickJumpTarget(lines, 2, 'prev')).toBeNull()
    expect(pickJumpTarget(lines, 0, 'prev')).toBeNull()
  })
})
