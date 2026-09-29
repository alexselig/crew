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

/**
 * Thrown by classifyOperation when the entries it was given cannot describe
 * a single operation. An unclassifiable state must be surfaced to the
 * caller, never silently defaulted to some classification — the whole
 * point of this table is that a wrong row can double-apply work to a shared
 * branch, and a wrong row derived from garbage input is worse than a thrown
 * error a caller can log and stop on.
 */
export class MalformedJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedJournalError'
  }
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
 * Validates that `entries` can describe exactly one operation, and returns
 * them sorted by `at`.
 *
 * classifyOperation derives its answer from entries[0].baseSha, a `phases`
 * set, and the first resultSha it finds. Each of those silently produces a
 * confident (and possibly wrong) classification if the entries actually
 * describe more than one operation — mixed opIds, conflicting baseShas, or
 * a phase written twice for the one two-write-per-effect journal that
 * should only ever contain it once. This function makes that impossible:
 * anything inconsistent throws MalformedJournalError instead of being
 * classified.
 *
 * Reordering decision: entries are expected to be read from the journal in
 * write order, but nothing requires a caller to pass them that way, and a
 * caller-supplied order is not itself evidence of corruption the way a
 * second opId is. Once every other consistency check below has passed, the
 * entries genuinely describe one operation regardless of array order, so
 * out-of-`at`-order-but-otherwise-consistent input is accepted and sorted
 * here rather than rejected — sorting makes entries[0].baseSha well-defined
 * by construction instead of accidentally correct.
 */
function validateAndOrder(
  entries: readonly RecoveryJournalEntry[]
): readonly RecoveryJournalEntry[] {
  const opIds = new Set(entries.map((e) => e.opId))
  if (opIds.size > 1) {
    throw new MalformedJournalError(
      `classifyOperation received entries for more than one opId: ${[...opIds].join(', ')}`
    )
  }

  const laneIds = new Set(entries.map((e) => e.laneId))
  if (laneIds.size > 1) {
    throw new MalformedJournalError(
      `classifyOperation received entries for more than one laneId: ${[...laneIds].join(', ')}`
    )
  }

  // baseSha must agree across every entry except an 'aborted' entry that
  // legitimately carries '' (an operation can abort before the base is
  // pinned — see conductor-journal.ts's write-time validator).
  const baseShas = new Set(
    entries.filter((e) => !(e.phase === 'aborted' && e.baseSha === '')).map((e) => e.baseSha)
  )
  if (baseShas.size > 1) {
    throw new MalformedJournalError(
      `classifyOperation received entries with conflicting baseSha values: ${[...baseShas].join(', ')}`
    )
  }

  // The two-write journal (intent, then one phase entry per effect) writes
  // each phase at most once per operation. A repeated phase — whether its
  // fields agree or conflict — means these entries did not all come from
  // one clean run of that protocol, so it is rejected outright rather than
  // guessed at.
  const seenPhases = new Set<RecoveryJournalEntry['phase']>()
  for (const e of entries) {
    if (seenPhases.has(e.phase)) {
      throw new MalformedJournalError(
        `classifyOperation received more than one '${e.phase}' entry for op ${e.opId}`
      )
    }
    seenPhases.add(e.phase)
  }

  // A resultSha is only ever produced once, at the moment the merge commits
  // ('merged' and 'published' both carry the *same* commit's sha). Two
  // different defined resultShas across the operation's entries is not a
  // state the two-write journal protocol can produce — it means these
  // entries describe more than one merge attempt, and classifyOperation's
  // "trust the first resultSha found" logic would otherwise silently pick
  // one of two contradictory stories.
  const resultShas = new Set(
    entries.map((e) => e.resultSha).filter((s): s is string => s !== undefined)
  )
  if (resultShas.size > 1) {
    throw new MalformedJournalError(
      `classifyOperation received entries with conflicting resultSha values: ${[...resultShas].join(', ')}`
    )
  }

  return [...entries].sort((a, b) => a.at - b.at)
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
 *     c. ref !== resultSha, 'published' journaled     -> externally-modified
 *        (the CAS already succeeded once; a ref that has since moved off
 *        the recorded result was moved by something outside Conductor —
 *        never treated as retryable, no matter where it now points)
 *     d. ref === baseSha, 'tests' journaled AND
 *        integration worktree dirty                   -> interrupted-tests
 *     e. ref === baseSha, otherwise                    -> merged-unpublished
 *     f. ref is none of the above                      -> externally-modified
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

  const ordered = validateAndOrder(entries)

  const phases = new Set(ordered.map((e) => e.phase))
  // 'aborted' and 'notified' are both terminal: the operation either gave up
  // cleanly or ran every step teammates depend on. Neither needs recovery,
  // and nothing after this point may re-examine baseSha/resultSha for them.
  if (phases.has('aborted') || phases.has('notified')) return 'complete'

  // Reachable here only for non-aborted entries, so baseSha is guaranteed
  // non-empty by the journal's own write-time validation (see
  // conductor-journal.ts's describeEntryViolation), and guaranteed
  // consistent across every entry by validateAndOrder above.
  const baseSha = ordered[0].baseSha
  const resultSha = ordered.find((e) => e.resultSha !== undefined)?.resultSha

  if (resultSha !== undefined) {
    if (reality.refSha === resultSha) {
      return phases.has('published') ? 'published-unnotified' : 'published-unrecorded'
    }
    // Finding 2: a journaled 'published' entry means the compare-and-swap
    // already succeeded once. If the ref is nevertheless not sitting on the
    // recorded result, the CAS did not merely fail to get retried — the ref
    // moved again, by something outside Conductor, after publication. That
    // is indistinguishable from any other externally-modified ref and must
    // fail closed the same way, never fall through to a "safe to redo" row
    // (interrupted-tests/merged-unpublished) that would re-run and
    // double-apply a merge that already landed.
    if (phases.has('published')) return 'externally-modified'
    if (reality.refSha === baseSha) {
      // A recorded resultSha means the merge committed; the ref sitting on
      // baseSha with a journaled 'tests' phase and a dirty integration
      // worktree means the crash happened *during* that test run, before
      // the compare-and-swap — not after tests passed and only the CAS was
      // left undone. Those need different recovery (redo the tests vs.
      // just retry the CAS), so they must not share a classification.
      if (phases.has('tests') && reality.integrationDirty) return 'interrupted-tests'
      return 'merged-unpublished'
    }
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
