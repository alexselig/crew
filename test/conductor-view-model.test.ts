import { describe, expect, it } from 'vitest'
import {
  buildRoster,
  conductorPanelMode,
  describeComposeFailure,
  describeOutcome,
  describeUnexpectedFailure,
  invalidateProposalNotes,
  shouldShowConductor
} from '../src/renderer/conductor-view-model'
import type { ConductorLane, ConductorSnapshot } from '../src/shared/conductor'
import type { ComposeResult } from '../src/shared/conductor-composer'
import type { ProposalNote } from '../src/shared/conductor-proposal'

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

describe('shouldShowConductor', () => {
  it('hides the panel when there is no snapshot yet', () => {
    expect(shouldShowConductor(null)).toBe(false)
  })

  it('hides the panel when the shipped conductor backend is disabled', () => {
    expect(shouldShowConductor(snapshot({ enabled: false }))).toBe(false)
  })

  it('shows the panel once an enabled snapshot arrives', () => {
    expect(shouldShowConductor(snapshot())).toBe(true)
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

  it('never claims nothing ran on a journal-failed outcome — a merge may already exist', () => {
    const message = describeOutcome({ ok: false, reason: 'journal-failed', message: 'disk full' })
    expect(message).not.toMatch(/nothing was run/i)
    expect(message).toContain('disk full')
    expect(message).toContain('manual attention')
  })
})

describe('describeUnexpectedFailure', () => {
  it('labels a publish rejection', () => {
    expect(describeUnexpectedFailure('publish', new Error('ipc channel closed')))
      .toBe('Publish failed unexpectedly: ipc channel closed')
  })

  it('labels a sync rejection', () => {
    expect(describeUnexpectedFailure('sync', new Error('boom')))
      .toBe('Sync failed unexpectedly: boom')
  })

  it('stringifies a non-Error rejection rather than crashing', () => {
    expect(describeUnexpectedFailure('publish', 'raw string')).toBe('Publish failed unexpectedly: raw string')
  })
})

describe('conductorPanelMode', () => {
  it('is loading before any snapshot has arrived', () => {
    expect(conductorPanelMode(null)).toBe('loading')
  })

  it('is empty once a disabled snapshot arrives — a normal, non-error state', () => {
    expect(conductorPanelMode(snapshot({ enabled: false }))).toBe('empty')
  })

  it('is active once an enabled snapshot arrives', () => {
    expect(conductorPanelMode(snapshot())).toBe('active')
  })
})

describe('describeComposeFailure', () => {
  const lane = (roleId: string): ConductorLane => ({
    id: `lane-${roleId}`, roleId, kind: 'author', branch: `crew/lane/${roleId}`,
    worktree: `/tmp/lanes/${roleId}`, sessionId: null,
    agent: { presetId: 'copilot-cli', model: null },
    status: 'working', dispatches: 0
  })

  it('reports nothing for a successful compose', () => {
    expect(describeComposeFailure({ ok: true, lanes: [] })).toBeNull()
  })

  it('falls back to a generic message for a pure validation rejection', () => {
    const result: ComposeResult = { ok: false, errors: [{ field: 'repo', message: 'choose a repository' }] }
    expect(describeComposeFailure(result)).toBe('Could not create the run — check the highlighted fields.')
  })

  it('reports the failure message alone when rollback fully cleaned up', () => {
    const result: ComposeResult = {
      ok: false, failedRow: 1, message: 'agent failed to launch',
      errors: [], cleanupFailures: [], survivingLanes: []
    }
    expect(describeComposeFailure(result)).toBe('agent failed to launch')
  })

  it('never pretends a failed compose left nothing behind — names every surviving lane', () => {
    const result: ComposeResult = {
      ok: false, failedRow: 1, message: 'agent failed to launch',
      errors: [],
      cleanupFailures: [{ resource: 'lane', id: 'lane-builder', message: 'worktree busy' }],
      survivingLanes: [lane('builder')]
    }
    const described = describeComposeFailure(result)
    expect(described).toContain('agent failed to launch')
    expect(described).toContain('builder')
    expect(described).toMatch(/still exist on disk/)
  })

  it('pluralises correctly for more than one surviving lane', () => {
    const result: ComposeResult = {
      ok: false, failedRow: 2, message: 'agent failed to launch',
      errors: [],
      cleanupFailures: [
        { resource: 'lane', id: 'lane-builder', message: 'x' },
        { resource: 'lane', id: 'lane-reviewer', message: 'x' }
      ],
      survivingLanes: [lane('builder'), lane('reviewer')]
    }
    const described = describeComposeFailure(result)
    expect(described).toContain('2 lanes')
    expect(described).toContain('builder, reviewer')
  })
})

describe('invalidateProposalNotes', () => {
  const blocking = (row: number, message = 'x'): ProposalNote => ({ row, severity: 'blocking', message })

  it('drops the note for a row the user just edited by hand', () => {
    const notes = [blocking(0), blocking(1, 'other')]
    const result = invalidateProposalNotes(notes, { type: 'update', index: 0 })
    expect(result).toEqual([blocking(1, 'other')])
  })

  it('leaves other rows and the roster-wide note (row -1) untouched on an update', () => {
    const notes = [blocking(-1, 'global'), blocking(0), blocking(2)]
    const result = invalidateProposalNotes(notes, { type: 'update', index: 1 })
    expect(result).toEqual([blocking(-1, 'global'), blocking(0), blocking(2)])
  })

  it('drops the note for a removed row and shifts later notes down to match the array', () => {
    const notes = [blocking(0, 'a'), blocking(1, 'b'), blocking(2, 'c')]
    const result = invalidateProposalNotes(notes, { type: 'remove', index: 1 })
    expect(result).toEqual([blocking(0, 'a'), blocking(1, 'c')])
  })

  it('never shifts the roster-wide note (row -1) when a row is removed', () => {
    const notes = [blocking(-1, 'global'), blocking(0)]
    const result = invalidateProposalNotes(notes, { type: 'remove', index: 0 })
    expect(result).toEqual([blocking(-1, 'global')])
  })

  it('leaves every note untouched when a row is merely added', () => {
    const notes = [blocking(-1, 'global'), blocking(0), blocking(1)]
    expect(invalidateProposalNotes(notes, { type: 'add' })).toEqual(notes)
  })
})
