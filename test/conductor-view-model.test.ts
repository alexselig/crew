import { describe, expect, it } from 'vitest'
import { buildRoster, describeOutcome } from '../src/renderer/conductor-view-model'
import type { ConductorSnapshot } from '../src/shared/conductor'

function snapshot(overrides: Partial<ConductorSnapshot> = {}): ConductorSnapshot {
  return {
    enabled: true,
    publishing: null,
    needsAttention: false,
    lanes: [
      {
        id: 'lane-1', roleId: 'builder', kind: 'author', branch: 'crew/lane/builder',
        worktree: '/tmp/lanes/builder', sessionId: 'sess-1',
        agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' },
        status: 'working', dispatches: 0
      }
    ],
    facts: {
      'lane-1': {
        baseSha: 'base', laneTip: 'tip', ahead: 2, behind: 0,
        dirtyTracked: false, untracked: false
      }
    },
    ...overrides
  }
}

describe('buildRoster', () => {
  it('enables publish for a lane that is ahead while the lock is free', () => {
    const [row] = buildRoster(snapshot())
    expect(row.canPublish).toBe(true)
    expect(row.publishHint).toBe('2 commits ready')
  })

  it('disables publish when the lane has nothing to publish', () => {
    const state = snapshot()
    state.facts['lane-1'].ahead = 0
    const [row] = buildRoster(state)
    expect(row.canPublish).toBe(false)
    expect(row.publishHint).toBe('nothing to publish')
  })

  it('disables publish on every lane while a publication is in flight', () => {
    const rows = buildRoster(snapshot({ publishing: 'lane-1' }))
    expect(rows.every((r) => r.canPublish)).toBe(false)
    expect(rows[0].publishHint).toBe('publication in progress')
    expect(rows[0].publishing).toBe(true)
  })

  it('enables sync only when the lane is behind', () => {
    const state = snapshot()
    expect(buildRoster(state)[0].canSync).toBe(false)
    state.facts['lane-1'].behind = 3
    const [row] = buildRoster(state)
    expect(row.canSync).toBe(true)
    expect(row.syncHint).toBe('3 commits behind')
  })

  // The one rule people get backwards.
  it('warns about a dirty tree without blocking publication', () => {
    const state = snapshot()
    state.facts['lane-1'].dirtyTracked = true
    state.facts['lane-1'].untracked = true
    const [row] = buildRoster(state)
    expect(row.canPublish).toBe(true)
    expect(row.warnings).toEqual([
      'uncommitted changes will not be published',
      'untracked files will not be published'
    ])
  })

  it('surfaces a blocked lane with its reason and still allows sync', () => {
    const state = snapshot()
    state.lanes[0].status = 'blocked'
    state.lanes[0].blockedReason = 'merge conflict in shared.txt'
    state.facts['lane-1'].behind = 1
    const [row] = buildRoster(state)
    expect(row.status).toBe('blocked')
    expect(row.statusDetail).toBe('merge conflict in shared.txt')
    expect(row.canSync).toBe(true)
  })

  // Facts are gathered per lane and can legitimately be missing for one that
  // was just created. An undefined read here would crash the whole panel.
  it('renders a lane whose facts have not arrived yet without crashing', () => {
    const state = snapshot()
    state.facts = {}
    const [row] = buildRoster(state)
    expect(row.ahead).toBe(0)
    expect(row.canPublish).toBe(false)
    expect(row.publishHint).toBe('measuring…')
  })

  it('shows the agent and model that runs the lane', () => {
    const [row] = buildRoster(snapshot())
    expect(row.agentLabel).toBe('copilot-cli · gpt-6-astra')
  })

  it('omits the model suffix for a preset that takes no model', () => {
    const state = snapshot()
    state.lanes[0].agent = { presetId: 'shell', model: null }
    expect(buildRoster(state)[0].agentLabel).toBe('shell')
  })
})

describe('describeOutcome', () => {
  it('names the commit on success', () => {
    expect(describeOutcome({ ok: true, commit: 'abcdef1234', touchedPaths: [], warnings: [] }))
      .toBe('Published abcdef1')
  })

  it('lists the conflicting paths', () => {
    expect(describeOutcome({ ok: false, reason: 'conflict', conflictPaths: ['a.txt', 'b.txt'], message: 'x' }))
      .toBe('Conflict in a.txt, b.txt — resolve in the lane, then publish again')
  })

  it('explains a rejection caused by the lock rather than the lane', () => {
    expect(describeOutcome({ ok: false, reason: 'busy' }))
      .toBe('Another lane is publishing — try again in a moment')
  })

  it('does not dress a failed test run up as an error', () => {
    expect(describeOutcome({ ok: false, reason: 'tests-failed', output: 'FAIL' }))
      .toBe('Tests failed on the merge result — nothing was published')
  })
})
