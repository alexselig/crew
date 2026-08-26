import { describe, it, expect } from 'vitest'
import { nextSelection } from '../src/shared/selection'

type S = { id: string; workspaceIds?: string[] }

const roster: S[] = [
  { id: 'a', workspaceIds: [] },
  { id: 'b', workspaceIds: ['ws_july'] },
  { id: 'c', workspaceIds: [] }
]

/** Apply the rule repeatedly, the way re-rendering does. */
function settle(start: string | null, workspace: string | null, list: S[] = roster): string | null {
  let cur = start
  for (let i = 0; i < 50; i++) {
    const next = nextSelection(list, cur, workspace)
    if (next === cur) return cur
    cur = next
  }
  throw new Error('selection never settled')
}

describe('choosing which session is selected', () => {
  it('settles on an empty workspace instead of oscillating forever', () => {
    // The bug: a workspace containing none of your sessions. One rule wanted a
    // selection from the whole roster, another refused any selection outside the
    // workspace, and the two overwrote each other as fast as the app could
    // re-render — which is what pinned the window and eventually killed it.
    expect(settle('a', 'ws_empty')).toBe(null)
  })

  it('selects nothing when the active workspace has no sessions', () => {
    expect(nextSelection(roster, 'a', 'ws_empty')).toBe(null)
    expect(nextSelection(roster, null, 'ws_empty')).toBe(null)
  })

  it('picks the first session when nothing is selected', () => {
    expect(nextSelection(roster, null, null)).toBe('a')
  })

  it('leaves a valid selection alone', () => {
    expect(nextSelection(roster, 'c', null)).toBe('c')
  })

  it('replaces a selection that has left the roster', () => {
    expect(nextSelection(roster, 'gone', null)).toBe('a')
  })

  it('never leaves a session selected that the workspace filter hides', () => {
    // 'a' is not in ws_july, so it must not stay selected while that filter is on.
    expect(nextSelection(roster, 'a', 'ws_july')).toBe('b')
  })

  it('keeps a selection that is inside the active workspace', () => {
    expect(nextSelection(roster, 'b', 'ws_july')).toBe('b')
  })

  it('settles from any starting point, filtered or not', () => {
    for (const ws of [null, 'ws_july', 'ws_empty']) {
      for (const start of [null, 'a', 'b', 'c', 'gone']) {
        expect(() => settle(start, ws)).not.toThrow()
      }
    }
  })

  it('selects nothing when there are no sessions at all', () => {
    expect(settle('a', null, [])).toBe(null)
  })
})
