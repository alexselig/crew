// Pure reconciliation. `finally` does not run when the process is killed, and
// Electron apps get quit, so every crash point must be classifiable from the
// journal plus what is actually on disk. No IO here on purpose: this table is
// the difference between a clean restart and double-applying work to a
// shared branch, and it must be exhaustively testable without a repo, a
// clock, or Electron.

import type { Classification } from './conductor'

export type { Classification }

/**
 * Structural shape of a journal entry, re-declared here (not imported) so
 * shared/ never depends on main/. Must stay assignable both ways with
 * src/main/conductor-journal.ts's JournalEntry — see the compile-time
 * assertion in test/conductor-recovery.test.ts, which fails to typecheck if
 * the two drift.
 *
 * baseSha/laneTip are always strings but may be empty ONLY for phase
 * 'aborted' (an operation can abort before the base is pinned). That rule is
 * enforced by conductor-journal.ts's validator on write/read, not by this
 * type: a flat structural interface cannot express "required unless phase is
 * X" any more precisely than "string", and over-narrowing it here would
 * break assignability with the real JournalEntry, which has the same
 * limitation.
 */
export interface RecoveryJournalEntry {
  opId: string
  laneId: string
  phase: 'intent' | 'merged' | 'tests' | 'published' | 'notified' | 'aborted'
  baseSha: string
  laneTip: string
  /** Required for 'merged' and 'published' only — enforced on write, not here. */
  resultSha?: string
  /** Required for 'aborted' only — enforced on write, not here. */
  detail?: string
  at: number
}

export interface OperationReality {
  /** What integrationBranch actually points at right now. */
  refSha: string
  /** MERGE_HEAD present in the integration worktree. */
  mergeHeadPresent: boolean
  /** The integration worktree has modifications (only ever produced by a
   *  test run in this feature — see classifyOperation). */
  integrationDirty: boolean
}

export interface RecoveryAction {
  summary: string
  /** Whether redoing the operation from the start is safe. */
  safeToRedo: boolean
  /** Whether the user must choose before anything runs. */
  requiresHuman: boolean
}

export const RECOVERY_ACTIONS: Record<Classification, RecoveryAction> = {
  'not-started': {
    summary: 'Nothing ran. Safe to publish again.',
    safeToRedo: true,
    requiresHuman: false
  },
  'interrupted-merge': {
    summary: 'A merge was in progress. Continue it or abort it — never silently restart.',
    safeToRedo: false,
    requiresHuman: true
  },
  'merged-unpublished': {
    summary: 'The merge commit exists but the branch never moved. Safe to retry the compare-and-swap.',
    safeToRedo: true,
    requiresHuman: false
  },
  'published-unrecorded': {
    summary: 'The branch already moved to the merge result. Record it and notify — never republish.',
    safeToRedo: false,
    requiresHuman: false
  },
  'published-unnotified': {
    summary: 'Published, but teammates were never told. Send the notification only.',
    safeToRedo: false,
    requiresHuman: false
  },
  'externally-modified': {
    summary: 'The branch points somewhere neither expected. Stopped — this needs a human.',
    safeToRedo: false,
    requiresHuman: true
  },
  'interrupted-tests': {
    summary: 'Killed during tests. Reset the integration worktree to the base, reap strays, redo.',
    safeToRedo: true,
    requiresHuman: false
  },
  complete: {
    summary: 'Nothing to reconcile.',
    safeToRedo: false,
    requiresHuman: false
  }
}

/**
 * Classifies one operation's journal entries against observed git reality.
 *
 * Table (mutually exclusive, checked in this order — see task-6-report.md
 * for the exhaustiveness argument):
 *
 *  1. empty journal                                  -> complete
 *  2. journal contains 'aborted' or 'notified'        -> complete
 *  3. a resultSha was recorded (merge produced a commit):
 *     a. ref === resultSha, 'published' journaled     -> published-unnotified
 *     b. ref === resultSha, 'published' NOT journaled -> published-unrecorded
 *     c. ref === baseSha                               -> merged-unpublished
 *     d. ref is neither                                -> externally-modified
 *  4. no resultSha recorded (merge never produced a commit):
 *     a. ref !== baseSha                                -> externally-modified
 *     b. MERGE_HEAD present                             -> interrupted-merge
 *     c. integration worktree dirty                     -> interrupted-tests
 *     d. otherwise                                      -> not-started
 */
export function classifyOperation(
  entries: readonly RecoveryJournalEntry[],
  reality: OperationReality
): Classification {
  if (entries.length === 0) return 'complete'

  const phases = new Set(entries.map((e) => e.phase))
  // 'aborted' and 'notified' are both terminal: the operation either gave up
  // cleanly or ran every step teammates depend on. Neither needs recovery,
  // and nothing after this point may re-examine baseSha/resultSha for them.
  if (phases.has('aborted') || phases.has('notified')) return 'complete'

  // Reachable here only for non-aborted entries, so baseSha is guaranteed
  // non-empty by the journal's own write-time validation (see
  // conductor-journal.ts's describeEntryViolation).
  const baseSha = entries[0].baseSha
  const resultSha = entries.find((e) => e.resultSha !== undefined)?.resultSha

  if (resultSha !== undefined) {
    if (reality.refSha === resultSha) {
      return phases.has('published') ? 'published-unnotified' : 'published-unrecorded'
    }
    if (reality.refSha === baseSha) return 'merged-unpublished'
    // The branch points somewhere that is neither the recorded result nor
    // the recorded base: something else moved it. Mid-merge (MERGE_HEAD)
    // cannot coexist with a recorded resultSha — a merge only ever produces
    // resultSha at the moment it commits, which is also the moment
    // MERGE_HEAD is cleared — so there is no branch here for it.
    return 'externally-modified'
  }

  // No commit was ever produced for this merge. A moved ref with nothing to
  // explain it is the same "someone else changed this" signal as above.
  if (reality.refSha !== baseSha) return 'externally-modified'
  if (reality.mergeHeadPresent) return 'interrupted-merge'
  // In this feature the integration worktree is only ever written to by a
  // test run (the merge step commits cleanly or leaves MERGE_HEAD, handled
  // above); a dirty worktree with the ref unmoved and no MERGE_HEAD is
  // therefore always a test run that got killed mid-flight, regardless of
  // whether a 'tests' entry made it into the journal before the kill.
  if (reality.integrationDirty) return 'interrupted-tests'
  return 'not-started'
}
