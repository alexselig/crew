import { describe, it, expect } from 'vitest'
import {
  classifyOperation,
  RECOVERY_ACTIONS,
  type OperationReality,
  type RecoveryJournalEntry
} from '../src/shared/conductor-recovery'
import type { Classification } from '../src/shared/conductor'
import type { JournalEntry } from '../src/main/conductor-journal'

const BASE = 'base-sha'
const RESULT = 'result-sha'

const entry = (
  phase: RecoveryJournalEntry['phase'],
  extra: Partial<RecoveryJournalEntry> = {}
): RecoveryJournalEntry => ({
  opId: 'op-1', laneId: 'lane-1', phase, baseSha: BASE, laneTip: 'tip', at: 1, ...extra
})

const reality = (over: Partial<OperationReality> = {}): OperationReality => ({
  refSha: BASE, mergeHeadPresent: false, integrationDirty: false, ...over
})

describe('classifyOperation', () => {
  it('classifies intent with untouched refs as not-started', () => {
    expect(classifyOperation([entry('intent')], reality())).toBe('not-started')
  })

  it('classifies a present MERGE_HEAD as an interrupted merge', () => {
    expect(classifyOperation([entry('intent')], reality({ mergeHeadPresent: true })))
      .toBe('interrupted-merge')
  })

  it('classifies a recorded result with an unmoved ref as merged-unpublished', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality())).toBe('merged-unpublished')
  })

  // The single most dangerous state: redoing it double-applies the work.
  it('classifies a ref equal to the result with no published entry as published-unrecorded', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('published-unrecorded')
  })

  it('classifies a published operation with no notification as published-unnotified', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('published-unnotified')
  })

  it('classifies a fully journalled operation as complete', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT }),
      entry('notified', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('complete')
  })

  it('classifies a ref matching neither base nor result as externally-modified', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality({ refSha: 'someone-elses-sha' })))
      .toBe('externally-modified')
  })

  it('classifies a moved ref with no result recorded as externally-modified', () => {
    expect(classifyOperation([entry('intent')], reality({ refSha: 'elsewhere' })))
      .toBe('externally-modified')
  })

  it('classifies a dirty integration worktree mid-tests as interrupted-tests', () => {
    const entries = [entry('intent'), entry('tests')]
    expect(classifyOperation(entries, reality({ integrationDirty: true })))
      .toBe('interrupted-tests')
  })

  it('classifies a dirty integration worktree with no tests entry as interrupted-tests too', () => {
    // Covers the "cannot occur, but if it did, don't call it safe by
    // omission" branch: dirt with no journaled 'tests' phase is still
    // treated the same as an interrupted test run, never as not-started.
    const entries = [entry('intent')]
    expect(classifyOperation(entries, reality({ integrationDirty: true })))
      .toBe('interrupted-tests')
  })

  it('treats an aborted operation as complete, needing no recovery', () => {
    const entries = [entry('intent'), entry('aborted', { detail: 'conflict' })]
    expect(classifyOperation(entries, reality())).toBe('complete')
  })

  it('classifies an empty journal as complete', () => {
    expect(classifyOperation([], reality())).toBe('complete')
  })

  // A merge is interrupted, not restartable-in-place: silently restarting
  // could discard a half-resolved index.
  it('never offers a silent redo for an interrupted merge', () => {
    expect(RECOVERY_ACTIONS['interrupted-merge'].safeToRedo).toBe(false)
    expect(RECOVERY_ACTIONS['interrupted-merge'].requiresHuman).toBe(true)
  })

  it('never republishes a published-unrecorded operation', () => {
    expect(RECOVERY_ACTIONS['published-unrecorded'].safeToRedo).toBe(false)
  })

  it('requires a human for external modification', () => {
    expect(RECOVERY_ACTIONS['externally-modified'].requiresHuman).toBe(true)
  })

  it('describes every classification', () => {
    const all: Array<keyof typeof RECOVERY_ACTIONS> = [
      'not-started', 'interrupted-merge', 'merged-unpublished', 'published-unrecorded',
      'published-unnotified', 'externally-modified', 'interrupted-tests', 'complete'
    ]
    for (const key of all) {
      expect(RECOVERY_ACTIONS[key].summary.length).toBeGreaterThan(0)
    }
  })

  it('keeps the shared recovery journal shape assignable both ways with the real JournalEntry', () => {
    // Compile-time only: if src/main/conductor-journal.ts's JournalEntry and
    // RecoveryJournalEntry ever drift (a field added/removed/retyped on
    // either side), this fails to typecheck under `npm run typecheck`, not
    // at runtime — see task instructions binding note 2.
    type AssertAssignable<A, B> = A extends B ? true : never
    const forward: AssertAssignable<JournalEntry, RecoveryJournalEntry> = true
    const backward: AssertAssignable<RecoveryJournalEntry, JournalEntry> = true
    expect(forward).toBe(true)
    expect(backward).toBe(true)
  })

  it('re-exports the shared Classification type used by the shared conductor snapshot', () => {
    // Guards against classifyOperation's return type silently diverging from
    // the Classification the rest of the app (ReconciledOperation) already
    // depends on.
    const value: Classification = classifyOperation([], reality())
    expect(value).toBe('complete')
  })
})
