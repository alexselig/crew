import { describe, it, expect } from 'vitest'
import { groupSessions } from '../src/renderer/grouping'
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

  it('buckets sessions by time since last prompt, most-recent bucket first', () => {
    const roster = [
      sess({ id: 'week', lastPromptAt: now - 3 * DAY }),
      sess({ id: 'halfhour', lastPromptAt: now - 10 * MIN }),
      sess({ id: 'day', lastPromptAt: now - 5 * HOUR }),
      sess({ id: 'hours', lastPromptAt: now - 90 * MIN })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Last 30 min', 'Last 2 hrs', 'Last day', 'Last week+'])
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([['halfhour'], ['hours'], ['day'], ['week']])
  })

  it('omits empty buckets and keeps fixed order', () => {
    const roster = [
      sess({ id: 'a', lastPromptAt: now - 45 * MIN }),
      sess({ id: 'b', lastPromptAt: now - 10 * DAY })
    ]
    expect(groupSessions(roster, 'recent').map((g) => g.name)).toEqual(['Last 2 hrs', 'Last week+'])
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
