import { describe, it, expect, beforeEach } from 'vitest'
import { groupSessions, partitionHidden, recencyOf, _resetRecencyOrder } from '../src/renderer/grouping'
import type { SessionInfo } from '../src/shared/types'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

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
  beforeEach(() => _resetRecencyOrder())

  it('uses time buckets when the roster is all within a day', () => {
    const roster = [
      sess({ id: 'twenty', lastPromptAt: now - 20 * HOUR }),
      sess({ id: 'halfhour', lastPromptAt: now - 10 * MIN }),
      sess({ id: 'fresh', lastPromptAt: now - 2 * MIN }),
      sess({ id: 'day', lastPromptAt: now - 5 * HOUR }),
      sess({ id: 'hours', lastPromptAt: now - 90 * MIN })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Last 30 min', 'Last 2 hrs', 'Last day'])
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([
      ['halfhour', 'fresh'],
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

  it('falls back to count buckets when the roster spans >1 day with little recent activity', () => {
    // 14 sessions, all prompted more than a day ago (nothing recent) → time
    // buckets would collapse into "week+"; use the count-based ranks instead.
    const roster = Array.from({ length: 14 }, (_, i) =>
      sess({ id: `s${i}`, lastPromptAt: now - (DAY + (i + 1) * HOUR) })
    )
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['4 most recent', '5-12 most recent', '13+ most recent'])
    // Bucket sizes: 4 / 8 / 2.
    expect(groups.map((g) => g.items.length)).toEqual([4, 8, 2])
    // s0 is newest (rank 1) → bottom of "4 most recent"; s13 oldest → bottom of "13+ most recent".
    expect(groups[0].items.map((s) => s.id)).toEqual(['s3', 's2', 's1', 's0'])
    expect(groups[2].items.map((s) => s.id)).toEqual(['s13', 's12'])
  })

  it('count-fallback omits empty rank buckets', () => {
    // 6 stale sessions (all > 1 day, none recent) → only the first two rank buckets appear.
    const roster = Array.from({ length: 6 }, (_, i) =>
      sess({ id: `s${i}`, lastPromptAt: now - (DAY + (i + 1) * HOUR) })
    )
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['4 most recent', '5-12 most recent'])
    expect(groups.map((g) => g.items.length)).toEqual([4, 2])
  })

  it('stays on the rank fallback while only one session is recently active', () => {
    // 11 stale sessions + 1 fresh prompt = 1 recent (< 2) → still rank buckets.
    const roster = [
      ...Array.from({ length: 11 }, (_, i) =>
        sess({ id: `old${i}`, lastPromptAt: now - (DAY + (i + 1) * HOUR) })
      ),
      sess({ id: 'active', lastPromptAt: now - 5 * MIN })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['4 most recent', '5-12 most recent'])
    // The lone active session ranks first → bottom of "4 most recent".
    expect(groups[0].items[groups[0].items.length - 1].id).toBe('active')
  })

  it('switches back to time buckets once 2+ sessions get fresh prompts', () => {
    // 10 stale sessions (> 1 day) + 2 freshly prompted → the rank fallback yields
    // to time buckets so the active work resurfaces into the recent groups.
    const roster = [
      ...Array.from({ length: 10 }, (_, i) =>
        sess({ id: `old${i}`, lastPromptAt: now - (DAY + (i + 1) * HOUR) })
      ),
      sess({ id: 'active1', lastPromptAt: now - 5 * MIN }),
      sess({ id: 'active2', lastPromptAt: now - 40 * MIN })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Last 30 min', 'Last 2 hrs', 'Last week+'])
    expect(groups.map((g) => g.name)).not.toContain('4 most recent')
    expect(groups[0].items.map((s) => s.id)).toEqual(['active1'])
    expect(groups[1].items.map((s) => s.id)).toEqual(['active2'])
    // Every stale session lands in the catch-all oldest bucket.
    expect((groups.find((g) => g.name === 'Last week+') as { items: unknown[] }).items.length).toBe(10)
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

  it('keeps within-bucket order stable when a session is re-prompted in the same bucket', () => {
    // A, B, C all in "Last 30 min", initial order oldest-first: A, B, C.
    let roster = [
      sess({ id: 'A', lastPromptAt: now - 20 * MIN }),
      sess({ id: 'B', lastPromptAt: now - 15 * MIN }),
      sess({ id: 'C', lastPromptAt: now - 10 * MIN })
    ]
    let g = groupSessions(roster, 'recent')
    expect(g[0].name).toBe('Last 30 min')
    expect(g[0].items.map((s) => s.id)).toEqual(['A', 'B', 'C'])

    // Re-prompt A (still within 30 min → same bucket): A must NOT jump around;
    // the first few items stay put.
    roster = [
      sess({ id: 'A', lastPromptAt: now }),
      sess({ id: 'B', lastPromptAt: now - 15 * MIN }),
      sess({ id: 'C', lastPromptAt: now - 10 * MIN })
    ]
    g = groupSessions(roster, 'recent')
    expect(g[0].items.map((s) => s.id)).toEqual(['A', 'B', 'C'])
  })

  it('appends a session to the end of a bucket when it first enters that bucket', () => {
    // A in "Last 2 hrs"; B, C in "Last 30 min".
    let roster = [
      sess({ id: 'A', lastPromptAt: now - 90 * MIN }),
      sess({ id: 'B', lastPromptAt: now - 20 * MIN }),
      sess({ id: 'C', lastPromptAt: now - 10 * MIN })
    ]
    groupSessions(roster, 'recent')

    // Prompt A → it jumps into "Last 30 min" and must land at the END, without
    // disturbing B and C.
    roster = [
      sess({ id: 'A', lastPromptAt: now }),
      sess({ id: 'B', lastPromptAt: now - 20 * MIN }),
      sess({ id: 'C', lastPromptAt: now - 10 * MIN })
    ]
    const g = groupSessions(roster, 'recent')
    const last30 = g.find((x) => x.name === 'Last 30 min')
    expect(last30?.items.map((s) => s.id)).toEqual(['B', 'C', 'A'])
  })
})

describe('partitionHidden', () => {
  const now = Date.now()
  const cutoff = now - 12 * HOUR
  const staleOrMinimized = (minimized: Set<string>) => (s: ReturnType<typeof sess>) =>
    minimized.has(s.id) || recencyOf(s) < cutoff

  it('splits a bucket into visible and hidden (stale) sessions', () => {
    const items = [
      sess({ id: 'fresh', lastPromptAt: now - 1 * HOUR }),
      sess({ id: 'stale', lastPromptAt: now - 20 * HOUR }),
      sess({ id: 'edge-in', lastPromptAt: cutoff }),
      sess({ id: 'edge-out', lastPromptAt: cutoff - 1 })
    ]
    const { visible, hidden } = partitionHidden(items, staleOrMinimized(new Set()))
    expect(visible.map((s) => s.id)).toEqual(['fresh', 'edge-in'])
    expect(hidden.map((s) => s.id)).toEqual(['stale', 'edge-out'])
  })

  it('hides manually-minimized sessions regardless of recency', () => {
    const items = [
      sess({ id: 'fresh', lastPromptAt: now - 1 * HOUR }),
      sess({ id: 'min', lastPromptAt: now - 1 * MIN })
    ]
    const { visible, hidden } = partitionHidden(items, staleOrMinimized(new Set(['min'])))
    expect(visible.map((s) => s.id)).toEqual(['fresh'])
    expect(hidden.map((s) => s.id)).toEqual(['min'])
  })

  it('uses createdAt when a session was never prompted', () => {
    const items = [
      sess({ id: 'new', createdAt: now - 2 * HOUR, lastPromptAt: undefined }),
      sess({ id: 'old', createdAt: now - 30 * HOUR, lastPromptAt: undefined })
    ]
    const { visible, hidden } = partitionHidden(items, staleOrMinimized(new Set()))
    expect(visible.map((s) => s.id)).toEqual(['new'])
    expect(hidden.map((s) => s.id)).toEqual(['old'])
  })

  it('preserves input order within each partition', () => {
    const items = [
      sess({ id: 'a', lastPromptAt: now - 1 * HOUR }),
      sess({ id: 'b', lastPromptAt: now - 40 * HOUR }),
      sess({ id: 'c', lastPromptAt: now - 2 * HOUR }),
      sess({ id: 'd', lastPromptAt: now - 50 * HOUR })
    ]
    const { visible, hidden } = partitionHidden(items, staleOrMinimized(new Set()))
    expect(visible.map((s) => s.id)).toEqual(['a', 'c'])
    expect(hidden.map((s) => s.id)).toEqual(['b', 'd'])
  })
})
