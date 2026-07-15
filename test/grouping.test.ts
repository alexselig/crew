import { describe, it, expect } from 'vitest'
import { groupSessions } from '../src/renderer/grouping'
import type { SessionInfo } from '../src/shared/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function sess(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  const now = Date.now()
  return {
    id: over.id,
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
      sess({ id: 'month', lastPromptAt: now - 10 * DAY }),
      sess({ id: 'hour', lastPromptAt: now - 5 * 60_000 }),
      sess({ id: 'week', lastPromptAt: now - 3 * DAY }),
      sess({ id: 'day', lastPromptAt: now - 5 * HOUR })
    ]
    const groups = groupSessions(roster, 'recent')
    expect(groups.map((g) => g.name)).toEqual(['Last hour', 'Last day', 'Last week', 'Last month'])
    expect(groups.map((g) => g.items.map((s) => s.id))).toEqual([['hour'], ['day'], ['week'], ['month']])
  })

  it('omits empty buckets and keeps fixed order', () => {
    const roster = [
      sess({ id: 'a', lastPromptAt: now - 2 * DAY }),
      sess({ id: 'b', lastPromptAt: now - 40 * DAY })
    ]
    expect(groupSessions(roster, 'recent').map((g) => g.name)).toEqual(['Last week', 'Older'])
  })

  it('within a bucket, orders oldest-first so a fresh prompt appends to the bottom', () => {
    const roster = [
      sess({ id: 'newest', lastPromptAt: now - 1 * 60_000 }),
      sess({ id: 'oldest', lastPromptAt: now - 50 * 60_000 }),
      sess({ id: 'mid', lastPromptAt: now - 20 * 60_000 })
    ]
    const [lastHour] = groupSessions(roster, 'recent')
    expect(lastHour.name).toBe('Last hour')
    // oldest at top, newest (most recent prompt) at the bottom
    expect(lastHour.items.map((s) => s.id)).toEqual(['oldest', 'mid', 'newest'])
  })

  it('falls back to createdAt when a session was never prompted', () => {
    const roster = [sess({ id: 'fresh', createdAt: now - 10 * 60_000, lastPromptAt: undefined })]
    expect(groupSessions(roster, 'recent')[0].name).toBe('Last hour')
  })
})
