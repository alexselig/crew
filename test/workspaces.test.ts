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

import {
  makeWorkspaceId,
  createWorkspace,
  renameWorkspace,
  describeWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  addMembership,
  removeMembership,
  moveMembership,
  isArchived,
  sessionInWorkspaceId,
  nameToIdMap,
  type Workspace
} from '../src/shared/workspaces'

const ws = (id: string, name: string, order: number): Workspace => ({ id, name, order, createdAt: 0 })

describe('makeWorkspaceId', () => {
  it('produces a unique ws_ id', () => {
    const a = makeWorkspaceId()
    const b = makeWorkspaceId()
    expect(a).toMatch(/^ws_[a-z0-9]{6,}$/)
    expect(a).not.toBe(b)
  })
})

describe('createWorkspace', () => {
  it('adds a trimmed workspace with next order', () => {
    const { list, created } = createWorkspace([ws('ws_a', 'A', 0)], '  B ', 5)
    expect(created?.name).toBe('B')
    expect(created?.order).toBe(1)
    expect(created?.createdAt).toBe(5)
    expect(list).toHaveLength(2)
  })
  it('rejects blank and case-insensitive duplicates', () => {
    expect(createWorkspace([ws('ws_a', 'Work', 0)], '  ', 0).created).toBeNull()
    expect(createWorkspace([ws('ws_a', 'Work', 0)], 'work', 0).created).toBeNull()
  })
})

describe('renameWorkspace', () => {
  it('renames by id, ignoring blank or duplicate-of-other', () => {
    const list = [ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)]
    expect(renameWorkspace(list, 'ws_a', 'A2').find((w) => w.id === 'ws_a')?.name).toBe('A2')
    expect(renameWorkspace(list, 'ws_a', 'b').find((w) => w.id === 'ws_a')?.name).toBe('A')
    expect(renameWorkspace(list, 'ws_a', 'A').find((w) => w.id === 'ws_a')?.name).toBe('A')
  })
})

describe('describeWorkspace', () => {
  it('sets/clears the description', () => {
    const list = [ws('ws_a', 'A', 0)]
    expect(describeWorkspace(list, 'ws_a', ' note ').find((w) => w.id === 'ws_a')?.description).toBe('note')
    expect(describeWorkspace(list, 'ws_a', '  ').find((w) => w.id === 'ws_a')?.description).toBeUndefined()
  })
})

describe('deleteWorkspace / reorderWorkspaces', () => {
  it('removes by id', () => {
    expect(deleteWorkspace([ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)], 'ws_a').map((w) => w.id)).toEqual(['ws_b'])
  })
  it('reorders and rewrites order to match ids', () => {
    const out = reorderWorkspaces([ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)], ['ws_b', 'ws_a'])
    expect(out.map((w) => [w.id, w.order])).toEqual([
      ['ws_b', 0],
      ['ws_a', 1]
    ])
  })
})

describe('membership reducers', () => {
  it('adds/removes/moves without duplicates', () => {
    expect(addMembership(undefined, 'ws_a')).toEqual(['ws_a'])
    expect(addMembership(['ws_a'], 'ws_a')).toEqual(['ws_a'])
    expect(removeMembership(['ws_a', 'ws_b'], 'ws_a')).toEqual(['ws_b'])
    expect(moveMembership(['ws_a'], 'ws_a', 'ws_b')).toEqual(['ws_b'])
    expect(moveMembership(['ws_a', 'ws_c'], 'ws_a', 'ws_c')).toEqual(['ws_c'])
  })
  it('isArchived when no memberships', () => {
    expect(isArchived(undefined)).toBe(true)
    expect(isArchived([])).toBe(true)
    expect(isArchived(['ws_a'])).toBe(false)
  })
})

describe('sessionInWorkspaceId', () => {
  it('null active matches all; otherwise exact id membership', () => {
    expect(sessionInWorkspaceId(['ws_a'], null)).toBe(true)
    expect(sessionInWorkspaceId(undefined, null)).toBe(true)
    expect(sessionInWorkspaceId(['ws_a'], 'ws_a')).toBe(true)
    expect(sessionInWorkspaceId(['ws_a'], 'ws_b')).toBe(false)
    expect(sessionInWorkspaceId(undefined, 'ws_a')).toBe(false)
  })
})

describe('nameToIdMap', () => {
  it('maps lowercased name -> id', () => {
    const m = nameToIdMap([ws('ws_a', 'July 2026', 0)])
    expect(m.get('july 2026')).toBe('ws_a')
  })
})
