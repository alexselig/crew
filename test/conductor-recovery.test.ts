import { describe, it, expect } from 'vitest'
import {
  classifyOperation,
  RECOVERY_ACTIONS,
  MalformedJournalError,
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

  // Finding 1: a resultSha alone does not mean the compare-and-swap is all
  // that's left to do — the crash may have happened mid-test-run, before
  // the CAS was ever attempted. That state needs a worktree reset + redo,
  // not a bare CAS retry, so it must not collapse into merged-unpublished.
  it('classifies a recorded result with a dirty worktree mid-tests as interrupted-tests, not merged-unpublished', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT }), entry('tests')]
    expect(classifyOperation(entries, reality({ integrationDirty: true })))
      .toBe('interrupted-tests')
  })

  // The other half of the distinction: the same entries, but the worktree
  // is clean — tests finished, only the CAS is outstanding.
  it('classifies a recorded result with a clean worktree after tests as merged-unpublished', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT }), entry('tests')]
    expect(classifyOperation(entries, reality({ integrationDirty: false })))
      .toBe('merged-unpublished')
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

  // Finding 2 regression guard: the fail-closed rule must trigger only when
  // the ref has moved *off* the recorded result, never for the legitimate
  // post-CAS state — refSha === resultSha still means published-unnotified,
  // in both a clean and a stray-dirty integration worktree.
  it('still classifies published + refSha === resultSha as published-unnotified with a dirty worktree', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: RESULT, integrationDirty: true })))
      .toBe('published-unnotified')
  })

  // Finding 1: two different defined resultShas for one operation is not a
  // state the two-write journal protocol can produce — it means these
  // entries describe more than one merge attempt, and must be rejected
  // rather than classified by trusting whichever resultSha is found first.
  it('throws on merged(A) followed by published(B) with conflicting resultShas', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: 'a-different-result-sha' })
    ]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('throws on merged(A), tests, published(B) with conflicting resultShas', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('tests'),
      entry('published', { resultSha: 'a-different-result-sha' })
    ]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  // Finding 2: once 'published' is journaled, the CAS already succeeded
  // once. A ref sitting back at baseSha must never be treated as a
  // retryable pre-CAS state (which would double-apply the merge) — it must
  // fail closed as externally-modified, in both a clean and a dirty
  // integration worktree.
  it('classifies published + refSha === baseSha (clean worktree) as externally-modified, not merged-unpublished', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: BASE, integrationDirty: false })))
      .toBe('externally-modified')
  })

  it('classifies published + refSha === baseSha (dirty worktree) as externally-modified, not interrupted-tests', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('tests'),
      entry('published', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: BASE, integrationDirty: true })))
      .toBe('externally-modified')
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

  // Finding 2: malformed input must be surfaced, never guessed at.
  it('throws on entries from more than one opId', () => {
    const entries = [entry('intent'), entry('merged', { opId: 'op-2', resultSha: RESULT })]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('throws on entries from more than one laneId', () => {
    const entries = [entry('intent'), entry('merged', { laneId: 'lane-2', resultSha: RESULT })]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('throws on entries with conflicting baseSha values', () => {
    const entries = [entry('intent'), entry('merged', { baseSha: 'other-base', resultSha: RESULT })]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('throws on a duplicate phase, even one that repeats identical fields', () => {
    const entries = [entry('intent'), entry('intent')]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('throws on a duplicate phase whose fields conflict', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('merged', { resultSha: 'a-different-result-sha' })
    ]
    expect(() => classifyOperation(entries, reality())).toThrow(MalformedJournalError)
  })

  it('does not throw on an aborted entry carrying an empty baseSha alongside a pinned one', () => {
    // Live rule: baseSha/laneTip may be empty ONLY for 'aborted', because an
    // operation can abort before the base is pinned. A journal with an
    // 'intent' (real baseSha) followed by 'aborted' (empty baseSha) is the
    // *other*, later-abort shape and must not be flagged as conflicting.
    const entries = [entry('intent'), entry('aborted', { baseSha: '', laneTip: '', detail: 'x' })]
    expect(classifyOperation(entries, reality())).toBe('complete')
  })

  it('classifies reordered-but-consistent entries the same as their written order', () => {
    const inOrder = [
      entry('intent', { at: 1 }),
      entry('merged', { at: 2, resultSha: RESULT }),
      entry('published', { at: 3, resultSha: RESULT })
    ]
    const shuffled = [inOrder[2], inOrder[0], inOrder[1]]
    const r = reality({ refSha: RESULT })
    expect(classifyOperation(shuffled, r)).toBe(classifyOperation(inOrder, r))
    expect(classifyOperation(shuffled, r)).toBe('published-unnotified')
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
