import { describe, expect, it } from 'vitest'
import {
  buildRoster,
  conductorPanelMode,
  describeAcknowledgeOutcome,
  describeAttention,
  describeComposeFailure,
  describeOutcome,
  describeReconcileReport,
  describeUnexpectedFailure,
  invalidateProposalNotes
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
    operations: [],
    // Reconciled by default: the interesting cases set it explicitly.
    reconciled: true,
    reconcileError: null,
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

// Review findings 6 and 9: a refusal that no form field can show — a
// repository git could not prepare, a workspace whose sessions already
// answer to another conducted workspace — used to render as "check the
// highlighted fields", pointing the user at fields that looked fine.
describe('describeComposeFailure: refusals no form field can show', () => {
  it('surfaces a workspace-level refusal verbatim', () => {
    const result: ComposeResult = {
      ok: false,
      errors: [{ field: 'workspace', message: 'this workspace cannot be conducted: Session One already belongs to Alpha' }]
    }
    expect(describeComposeFailure(result)).toContain('Session One already belongs to Alpha')
  })

  it('still falls back to the generic message for errors the form does highlight', () => {
    const result: ComposeResult = { ok: false, errors: [{ field: 'repo', message: 'choose a repository' }] }
    expect(describeComposeFailure(result)).toBe('Could not create the run — check the highlighted fields.')
  })

  it('reports only the unfielded errors when a refusal carries both kinds', () => {
    const result: ComposeResult = {
      ok: false,
      errors: [
        { field: 'rows[0].roleName', message: 'name this lane' },
        { field: 'workspace', message: 'pick a workspace first' }
      ]
    }
    expect(describeComposeFailure(result)).toBe('pick a workspace first')
  })
})

// Review finding 7: the panel has to say WHY publish and sync are refusing,
// and offer the one action that clears it.
describe('describeAttention', () => {
  it('says nothing when the workspace is disabled', () => {
    expect(describeAttention(snapshot({ enabled: false }))).toBeNull()
  })

  it('says nothing when reconcile has run and found nothing', () => {
    expect(describeAttention(snapshot())).toBeNull()
  })

  it('explains the pre-reconcile gate, which is not an error state', () => {
    expect(describeAttention(snapshot({ reconciled: false }))).toBe('Checking for interrupted operations…')
  })

  it('names the operation that needs a human, rather than merely counting it', () => {
    const message = describeAttention(snapshot({
      needsAttention: true,
      operations: [
        { opId: 'op-1', laneId: 'lane-1', classification: 'interrupted-merge', summary: 'publish of builder may be half-applied', safeToRedo: false, requiresHuman: true },
        { opId: 'op-2', laneId: 'lane-2', classification: 'complete', summary: 'publish of scout completed', safeToRedo: false, requiresHuman: false }
      ]
    }))
    expect(message).toContain('publish of builder may be half-applied')
    expect(message).not.toContain('publish of scout completed')
  })

  it('still says something useful when needsAttention is set with no operations to name', () => {
    const message = describeAttention(snapshot({ needsAttention: true, operations: [] }))
    expect(message).toContain('holding publish and sync')
    // I-1: the banner has to name the way out, or the user is told only
    // that they are stuck.
    expect(message).toContain('acknowledge')
  })

  // I-1: the banner and the refusal have to agree, and the banner must not
  // contradict the operation summary printed beside it. An operation that
  // needs no human judgement still holds the gate until acknowledged.
  it('names acknowledging as the exit even when no operation requires a human', () => {
    const message = describeAttention(snapshot({
      needsAttention: true,
      operations: [
        { opId: 'op-1', laneId: 'lane-1', classification: 'not-started', summary: 'Nothing ran. Safe to publish again.', safeToRedo: true, requiresHuman: false }
      ]
    }))
    expect(message).toContain('Nothing ran. Safe to publish again.')
    expect(message).toContain('Acknowledge')
    expect(message).not.toContain('needs a human')
  })

  // m-2: a reconcile that failed or came back busy is a stopped check, not
  // an in-flight one. Reporting "checking…" there claimed progress that had
  // already ended, and hid the only thing that would help: pressing
  // Re-check.
  it('reports a failed reconcile instead of claiming a check is still running', () => {
    const message = describeAttention(snapshot({ reconciled: false, reconcileError: 'integration worktree is missing' }))
    expect(message).toContain('integration worktree is missing')
    expect(message).not.toContain('Checking for interrupted operations…')
    expect(message).toContain('Re-check')
  })

  it('reports a busy reconcile the same way, since nothing is checking after it either', () => {
    const message = describeAttention(snapshot({
      reconciled: false,
      reconcileError: 'conductor was busy with another operation'
    }))
    expect(message).toContain('busy')
    expect(message).not.toContain('Checking for interrupted operations…')
  })
})

describe('describeAcknowledgeOutcome', () => {
  const report = (needsAttention: boolean, summaries: string[] = []) => ({
    needsAttention,
    operations: summaries.map((summary, index) => ({
      opId: `op-${index}`,
      laneId: 'lane-1',
      classification: 'interrupted-merge' as const,
      summary,
      safeToRedo: false,
      requiresHuman: true
    }))
  })

  it('reports the gate reopening only when the reconcile that followed found nothing', () => {
    const message = describeAcknowledgeOutcome({ ok: true, phase: 'aborted', report: report(false) })
    expect(message).toContain('available again')
  })

  // Acknowledging closes ONE operation. If another is outstanding the gate
  // is still shut, so claiming success there would be a lie the user acts on.
  it('does not claim the gate reopened when another operation is still outstanding', () => {
    const message = describeAcknowledgeOutcome({
      ok: true,
      phase: 'notified',
      report: report(true, ['publish of scout may be half-applied'])
    })
    expect(message).toContain('publish of scout may be half-applied')
    expect(message).not.toContain('available again')
  })

  it('reports a busy refusal as a retry, not a failure', () => {
    expect(describeAcknowledgeOutcome({ ok: false, reason: 'busy', message: 'busy' }))
      .toContain('busy')
  })

  it('passes through the specific reason a stale acknowledge was refused', () => {
    expect(describeAcknowledgeOutcome({ ok: false, reason: 'stale', message: 'op-1 is no longer the newest operation' }))
      .toContain('op-1 is no longer the newest operation')
  })

  it('tells the user nothing changed when the journal write failed', () => {
    const message = describeAcknowledgeOutcome({ ok: false, reason: 'journal-failed', message: 'disk full' })
    expect(message).toContain('nothing changed')
    expect(message).toContain('disk full')
  })
})

describe('describeReconcileReport', () => {
  it('tells the user to try again when reconcile could not run at all', () => {
    expect(describeReconcileReport({ needsAttention: false, operations: [], busy: true }))
      .toContain('busy')
  })

  it('reports the gate reopening when nothing was interrupted', () => {
    expect(describeReconcileReport({ needsAttention: false, operations: [] }))
      .toContain('no interrupted operation')
  })

  // I-1: 'not-started' means nothing ran, so "still needs a human"
  // contradicted the summary printed next to it. It still holds the gate,
  // but what it needs is an acknowledgement, not a judgement call.
  it('tells the user to acknowledge, not to adjudicate, when no operation requires a human', () => {
    const message = describeReconcileReport({
      needsAttention: true,
      operations: [
        { opId: 'op-1', laneId: 'lane-1', classification: 'not-started', summary: 'Nothing ran. Safe to publish again.', safeToRedo: true, requiresHuman: false }
      ]
    })
    expect(message).toContain('Nothing ran. Safe to publish again.')
    expect(message).toContain('Acknowledge')
    expect(message).not.toContain('needs a human')
  })

  // Wave 3, finding 7: naming the operation is not enough — "Still needs a
  // human" told the user what was wrong and nothing about what to do, even
  // though reviewing it and acknowledging it is exactly what reopens the
  // gate. The guidance has to be actionable for an operation that genuinely
  // needs judgement too, not only for the easy ones.
  it('names what still needs a human, and says what to do about it', () => {
    const message = describeReconcileReport({
      needsAttention: true,
      operations: [
        { opId: 'op-1', laneId: 'lane-1', classification: 'interrupted-merge', summary: 'publish of builder may be half-applied', safeToRedo: false, requiresHuman: true }
      ]
    })
    expect(message).toContain('publish of builder may be half-applied')
    expect(message).toContain('Acknowledge')
  })
})

// Wave 3, finding 3: acknowledging is refused outright while the integration
// worktree is still mid-merge, because publish would fail the instant the
// user tried it. The panel has to say that nothing changed and name what
// needs attention — never "available again".
describe('describeAcknowledgeOutcome, when the worktree is still wedged', () => {
  it('says nothing was acknowledged and passes the repair failure through', () => {
    const message = describeAcknowledgeOutcome({
      ok: false,
      reason: 'worktree-wedged',
      message: 'the integration worktree at /w is still mid-merge and could not be repaired (permission denied)'
    })
    expect(message).toContain('Nothing was acknowledged')
    expect(message).toContain('permission denied')
    expect(message).not.toContain('available again')
  })
})
