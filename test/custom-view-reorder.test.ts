import { describe, expect, it } from 'vitest'
import { reorderViewItems } from '../src/shared/custom-views'
import type { CustomViewItem } from '../src/shared/types'

const items = (...ids: string[]): CustomViewItem[] =>
  ids.map((sessionId) => ({ sessionId, labelSnapshot: `snap:${sessionId}` }))

const ids = (list: CustomViewItem[]): string[] => list.map((i) => i.sessionId)
const label = (id: string): string => `live:${id}`

describe('reorderViewItems', () => {
  it('drops after the target when dragging downward', () => {
    // a is before c, so dropping a onto c lands it after c.
    expect(ids(reorderViewItems(items('a', 'b', 'c', 'd'), 'a', 'c', label))).toEqual([
      'b',
      'c',
      'a',
      'd'
    ])
  })

  it('drops before the target when dragging upward', () => {
    expect(ids(reorderViewItems(items('a', 'b', 'c', 'd'), 'd', 'b', label))).toEqual([
      'a',
      'd',
      'b',
      'c'
    ])
  })

  it('is a no-op when a session is dropped on itself', () => {
    const before = items('a', 'b')
    expect(ids(reorderViewItems(before, 'a', 'a', label))).toEqual(['a', 'b'])
  })

  it('pins an unranked session at the slot it is dropped onto', () => {
    // 'x' is not in the view yet (ranked-plus-all shows it anyway).
    expect(ids(reorderViewItems(items('a', 'b', 'c'), 'x', 'b', label))).toEqual([
      'a',
      'x',
      'b',
      'c'
    ])
  })

  it('appends to the end of the ranked block when the target is unranked', () => {
    expect(ids(reorderViewItems(items('a', 'b'), 'x', 'unranked', label))).toEqual(['a', 'b', 'x'])
  })

  it('keeps the existing labelSnapshot of a session that was already ranked', () => {
    const next = reorderViewItems(items('a', 'b', 'c'), 'c', 'a', label)
    expect(next.find((i) => i.sessionId === 'c')?.labelSnapshot).toBe('snap:c')
  })

  it('takes a fresh label snapshot for a newly pinned session', () => {
    const next = reorderViewItems(items('a', 'b'), 'x', 'a', label)
    expect(next.find((i) => i.sessionId === 'x')?.labelSnapshot).toBe('live:x')
  })

  it('never duplicates a session', () => {
    const next = reorderViewItems(items('a', 'b', 'c'), 'a', 'c', label)
    expect(new Set(ids(next)).size).toBe(next.length)
  })

  it('does not mutate the array it was given', () => {
    const before = items('a', 'b', 'c')
    reorderViewItems(before, 'a', 'c', label)
    expect(ids(before)).toEqual(['a', 'b', 'c'])
  })

  it('returns an equal order rather than throwing when the drag id is unknown to both lists', () => {
    // Dropping onto a target that is also unranked degrades to "append".
    expect(ids(reorderViewItems(items('a'), 'ghost', 'other', label))).toEqual(['a', 'ghost'])
  })
})
