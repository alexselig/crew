import { describe, it, expect } from 'vitest'
import { groupSessions } from '../src/renderer/grouping'
import type { SessionInfo } from '../src/shared/types'

const MIN = 60_000
const HOUR = 60 * MIN

function sess(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  const now = Date.now()
  return {
    label: over.id,
    characterId: 'fox',
    color: '#fff',
    presetId: null,
    command: 'copilot',
    args: [],
    cwd: '/x',
    state: 'WORKING',
    status: 'active',
    pid: 1,
    exitCode: null,
    costUsd: 0,
    creditsUsed: 0,
    autopilot: false,
    createdAt: now,
    stateChangedAt: now,
    ...over
  }
}

describe("groupSessions 'recent'", () => {
  const now = Date.now()

  it('uses time buckets when the roster is all within a day', () => {
    const roster = [
      sess({ id: 'twenty', lastPromptAt: now - 20 * HOUR }),
      sess({ id: 'halfhour', lastPromptAt: now - 10 * MIN }),
      sess({ id: 'fresh', lastPromptAt: now - 2 * MIN }),
      sess({ id: 'day', lastPromptAt: now - 5 * HOUR }),
      sess({ id: 'hours', lastPromptAt: now - 90 * MIN })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual([
      'Last 5 min',
      'Last 30 min',
      'Last 2 hrs',
      'Last day'
    ])
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([
      ['fresh'],
      ['halfhour'],
      ['hours'],
      ['twenty', 'day']
    ])
  })

  it('omits empty buckets and keeps fixed order', () => {
    const roster = [
      sess({ id: 'a', lastPromptAt: now - 45 * MIN }),
      sess({ id: 'b', lastPromptAt: now - 20 * HOUR })
    ]
    expect(groupSessions(roster, 'recent').map((g) => g.name)).toEqual(['Last 2 hrs', 'Last day'])
  })

  it('falls back to count buckets when the roster spans more than a day', () => {
    // 14 sessions, the oldest ~2 days ago → time buckets would collapse; use ranks.
    const roster = Array.from({ length: 14 }, (_, i) =>
      sess({ id: `s${i}`, lastPromptAt: now - i * 3 * HOUR })
    )
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Most recent 4', 'Most recent 5-12', '13+'])
    // Bucket sizes: 4 / 8 / 2.
    expect(groups.map((g) => g.items.length)).toEqual([4, 8, 2])
    // s0 is newest (rank 1) → bottom of "Most recent 4"; s13 oldest → bottom of "13+".
    expect(groups[0].items.map((s) => s.id)).toEqual(['s3', 's2', 's1', 's0'])
    expect(groups[2].items.map((s) => s.id)).toEqual(['s13', 's12'])
  })

  it('count-fallback omits empty rank buckets', () => {
    // 6 sessions spanning > 1 day → only the first two rank buckets appear.
    const roster = Array.from({ length: 6 }, (_, i) =>
      sess({ id: `s${i}`, lastPromptAt: now - i * 6 * HOUR })
    )
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Most recent 4', 'Most recent 5-12'])
    expect(groups.map((g) => g.items.length)).toEqual([4, 2])
  })

  it('within a bucket, orders oldest-first so a fresh prompt appends to the bottom', () => {
    const roster = [
      sess({ id: 'newest', lastPromptAt: now - 35 * MIN }),
      sess({ id: 'oldest', lastPromptAt: now - 110 * MIN }),
      sess({ id: 'mid', lastPromptAt: now - 60 * MIN })
    ]
    const [bucket] = groupSessions(roster, 'recent')
    expect(bucket.name).toBe('Last 2 hrs')
    // oldest at top, newest (most recent prompt) at the bottom
    expect(bucket.items.map((s) => s.id)).toEqual(['oldest', 'mid', 'newest'])
  })

  it('falls back to createdAt when a session was never prompted', () => {
    const roster = [sess({ id: 'fresh', createdAt: now - 10 * MIN, lastPromptAt: undefined })]
    expect(groupSessions(roster, 'recent')[0].name).toBe('Last 30 min')
  })
})
