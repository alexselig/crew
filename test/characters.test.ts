import { describe, it, expect } from 'vitest'
import { CHARACTERS, isCharacterId, pickCharacter } from '../src/main/characters'

describe('isCharacterId', () => {
  it('accepts real character ids', () => {
    expect(isCharacterId('fox')).toBe(true)
    expect(isCharacterId('duck')).toBe(true)
  })

  it('rejects non-characters (e.g. a stray session UUID) and empty values', () => {
    expect(isCharacterId('b2c1ef6b-b1bb-4a17-a7ee-6dac398ca74a')).toBe(false)
    expect(isCharacterId('')).toBe(false)
    expect(isCharacterId(undefined)).toBe(false)
    expect(isCharacterId(null)).toBe(false)
  })
})

describe('pickCharacter', () => {
  it('honors a real, free preferred character', () => {
    expect(pickCharacter(new Set(), 'owl')).toBe('owl')
  })

  it('skips a preferred character that is already in use', () => {
    const pick = pickCharacter(new Set(['fox']), 'fox')
    expect(pick).not.toBe('fox')
    expect(isCharacterId(pick)).toBe(true)
  })

  it('ignores an invalid preferred id instead of returning it', () => {
    // Regression: a session UUID persisted as characterId must not be handed
    // back as a "character" (it renders as a bare colored circle).
    const uuid = 'b2c1ef6b-b1bb-4a17-a7ee-6dac398ca74a'
    const pick = pickCharacter(new Set(), uuid)
    expect(pick).not.toBe(uuid)
    expect(isCharacterId(pick)).toBe(true)
    expect(pick).toBe(CHARACTERS[0].id)
  })

  it('always returns a valid character even when all are in use', () => {
    const all = new Set(CHARACTERS.map((c) => c.id))
    expect(isCharacterId(pickCharacter(all, 'fox'))).toBe(true)
  })
})
