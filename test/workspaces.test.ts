import { describe, it, expect } from 'vitest'
import {
  normalizeSetNames,
  sessionInWorkspace,
  workspaceNames,
  addToSets,
  removeFromSets
} from '../src/shared/workspaces'

describe('normalizeSetNames', () => {
  it('trims, drops empties, and de-dupes case-insensitively (keeping first spelling)', () => {
    expect(normalizeSetNames([' July 2026 ', '', 'july 2026', null, 'Microsoft', undefined])).toEqual([
      'July 2026',
      'Microsoft'
    ])
  })
})

describe('sessionInWorkspace', () => {
  it('matches everything when no workspace is active (All Sessions)', () => {
    expect(sessionInWorkspace(undefined, null)).toBe(true)
    expect(sessionInWorkspace(['x'], null)).toBe(true)
  })

  it('matches only members of the active workspace (case-insensitive)', () => {
    expect(sessionInWorkspace(['July 2026', 'Microsoft'], 'microsoft')).toBe(true)
    expect(sessionInWorkspace(['July 2026'], 'Microsoft')).toBe(false)
    expect(sessionInWorkspace(undefined, 'Microsoft')).toBe(false)
  })
})

describe('workspaceNames', () => {
  it('unions saved set names with every session membership, sorted, de-duped', () => {
    const names = workspaceNames(
      ['July 2026'],
      [['Microsoft July 2026'], ['July 2026'], undefined, ['microsoft july 2026']]
    )
    expect(names).toEqual(['July 2026', 'Microsoft July 2026'])
  })
})

describe('addToSets / removeFromSets', () => {
  it('adds without duplicating (case-insensitive)', () => {
    expect(addToSets(['July 2026'], 'july 2026')).toEqual(['July 2026'])
    expect(addToSets(['July 2026'], 'Microsoft')).toEqual(['July 2026', 'Microsoft'])
  })

  it('removes case-insensitively', () => {
    expect(removeFromSets(['July 2026', 'Microsoft'], 'microsoft')).toEqual(['July 2026'])
    expect(removeFromSets(undefined, 'x')).toEqual([])
  })
})
