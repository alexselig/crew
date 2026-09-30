// The conductor runtime. Owns the single-flight publication lock and the
// publication transaction; every git invocation goes through the lane manager.
//
// Phase 1 only: there is no router, no dispatcher, no ready set and no agent
// automation here. The user's buttons are the only triggers.

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runGit, runSupervised } from './supervise'
import type { LaneManager } from './lanes'
import type { Journal, JournalPhase } from './conductor-journal'
import { classifyOperation, MalformedJournalError, RECOVERY_ACTIONS } from '../shared/conductor-recovery'
import type {
  ConductorLane,
  ConductorSettings,
  TestRecipe,
  PublishOutcome,
  SyncOutcome,
  ReconciledOperation,
  ReconcileReport
} from '../shared/conductor'

// The outcome types are declared in src/shared/conductor.ts, not here: they
// cross the IPC boundary and are read by the renderer, which must never import
// from src/main.

export interface ConductorDeps {
  lanes: LaneManager
  journal: Journal
  settings: ConductorSettings
  /** Injectable so the runtime's tests never depend on a real test suite. */
  runTests?: (worktree: string, recipe: TestRecipe) => Promise<{ ok: boolean; output: string }>
  now?: () => number
  newOpId?: () => string
}

export interface Conductor {
  publishLane(lane: ConductorLane): Promise<PublishOutcome>
  syncLane(lane: ConductorLane): Promise<SyncOutcome>
  isPublishing(): boolean
  /** The lane id (or the 'reconcile' sentinel) currently holding the
   *  single-flight lock, or null when nothing does. Task 5, finding 1: the
   *  IPC backend used to track its own `publishingLaneId`, fed only by its
   *  own before/after bookkeeping around publishLane/syncLane — never by
   *  reconcile(), and clobbered by a second busy caller's `finally` while
   *  the first was still running. Reading straight from the lock this file
   *  already owns replaces that shadow copy with the one true answer. */
  lockHolder(): string | null
  /** Reserves the single-flight lock for an operation that is not itself a
   *  publish/sync/reconcile (Task 5, finding 2: lane destruction) but still
   *  must not run concurrently with one — removing a lane's worktree out
   *  from under an in-flight merge is exactly the race publishLane's and
   *  syncLane's own reservation comments exist to prevent. Returns false,
   *  reserving nothing, when the lock is already held; true when this call
   *  took it. Checked and set synchronously, before any await, for the same
   *  TOCTOU reason every other acquisition in this file is. */
  reserveLock(holder: string): boolean
  /** Releases a lock this caller reserved via reserveLock(). Always call
   *  from a finally, exactly like every other release in this file. */
  releaseLock(): void
  reconcile(): Promise<ReconcileReport>
}

/**
 * Thrown by reconcile() when a publication, a sync, or another reconcile is
 * already holding the single-flight lock. Distinct from any other error this
 * file can throw (a raw GitError from a failed git invocation, or an
 * unexpected non-MalformedJournalError re-thrown from classifyOperation) so
 * a caller can tell "refused because busy, try again shortly" apart from
 * "this attempt genuinely failed" without inspecting message text — the same
 * distinction publishLane and syncLane make through their `reason: 'busy'`
 * data field. reconcile() cannot make that distinction through its return
 * value: ReconcileReport has no failure shape (it always describes a
 * completed inspection of the journal), and inventing one would be exactly
 * the kind of type change this task's scope asks to avoid unless genuinely
 * required — throwing does not require it.
 */
export class ConductorBusyError extends Error {
  constructor() {
    super('conductor is busy: a publication, sync, or reconcile is already in flight')
    this.name = 'ConductorBusyError'
  }
}

async function defaultRunTests(
  worktree: string,
  recipe: TestRecipe
): Promise<{ ok: boolean; output: string }> {
  const cwd = join(worktree, recipe.cwd)
  if (recipe.setup) {
    const setup = await runSupervised(recipe.setup.command, recipe.setup.args, {
      cwd,
      timeoutMs: recipe.setup.timeoutMs
    })
    if (setup.code !== 0) {
      return { ok: false, output: `${setup.stdout}\n${setup.stderr}`.trim() }
    }
  }
  const run = await runSupervised(recipe.command, recipe.args, { cwd, timeoutMs: recipe.timeoutMs })
  return { ok: run.code === 0, output: `${run.stdout}\n${run.stderr}`.trim() }
}

export function createConductor(deps: ConductorDeps): Conductor {
  const { lanes, journal, settings } = deps
  const runTests = deps.runTests ?? defaultRunTests
  const now = deps.now ?? (() => Date.now())
  const newOpId = deps.newOpId ?? (() => randomUUID())

  // The single-flight lock. Assigned synchronously, before any await, because
  // main-thread JavaScript does not serialise across await: two callers could
  // otherwise both observe null and both proceed.
  let publishing: string | null = null

  const isPublishing = (): boolean => publishing !== null

  const lockHolder = (): string | null => publishing

  const reserveLock = (holder: string): boolean => {
    if (publishing !== null) return false
    publishing = holder
    return true
  }

  const releaseLock = (): void => {
    publishing = null
  }

  const publishLane = async (lane: ConductorLane): Promise<PublishOutcome> => {
    if (publishing !== null) return { ok: false, reason: 'busy' }

    // Finding 1: newOpId() is fallible (it is caller-injectable, e.g. in
    // tests) and used to sit AFTER `publishing = lane.id` but BEFORE the
    // try/finally that releases it. If it threw, the lock was set and
    // nothing ever cleared it: every later publishLane/syncLane/reconcile
    // would be refused forever. Computing it here, before the lock is
    // acquired and while nothing has been reserved yet, means a throw here
    // never leaves anything to release. If it throws, this is reported the
    // same way any other pre-flight failure is (reason: 'error'), rather
    // than becoming an unhandled rejection out of a function every other
    // path resolves from.
    let opId: string
    try {
      opId = newOpId()
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }

    publishing = lane.id
    let journalledIntent = false
    // Finding 7: hoisted out of the inner try so the generic catch-all below
    // can attempt a cleanup reset for exactly the window where one is owed —
    // set the instant the merge actually produces a commit in the
    // integration worktree. It is never cleared once set: every other path
    // through this function that already resets or otherwise resolves that
    // commit (the 'merged'/'tests' write-failure handlers, the tests-failed
    // path, the publish-failure path, and the success path) returns
    // directly instead of falling through to the catch-all, so the only
    // code that ever reads this variable again is the catch-all itself, at
    // most once per publishLane() call. If an unexpected exception lands
    // while this is set, the catch-all knows there is real, unrecorded
    // merge-commit state to account for before it may consider the
    // operation cleanly aborted.
    let mergedBaseShaPendingCleanup: string | undefined

    try {
      // 1. Preconditions. Dirty is advisory: publication operates on a frozen
      //    commit, so a dirty tree cannot leak into it.
      const facts = await lanes.facts(lane)
      if (facts.ahead === 0) return { ok: false, reason: 'nothing-to-publish' }

      const warnings: string[] = []
      if (facts.dirtyTracked) warnings.push('uncommitted-tracked-changes')
      if (facts.untracked) warnings.push('untracked-files')

      // 2 & 3. Pin the base and freeze the candidate. Both are SHAs from here
      //        on, never "whatever the branch points at later".
      const { baseSha, laneTip } = facts

      const write = (phase: JournalPhase, resultSha?: string, detail?: string): void => {
        journal.append({ opId, laneId: lane.id, phase, baseSha, laneTip, resultSha, detail, at: now() })
      }

      // Fail closed: if intent cannot be recorded, nothing may run, because a
      // crash would then be unclassifiable.
      try {
        write('intent')
        journalledIntent = true
      } catch (error) {
        return {
          ok: false,
          reason: 'journal-failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }

      lane.status = 'publishing'

      // 4. Merge, never rebase.
      const merged = await lanes.mergeInIntegration(laneTip, baseSha)
      if (!merged.ok) {
        lane.status = 'blocked'
        lane.blockedReason = `merge conflict in ${merged.conflictPaths.join(', ') || 'the integration worktree'}`
        safeWrite(write, 'aborted', undefined, merged.message)
        return {
          ok: false,
          reason: 'conflict',
          conflictPaths: merged.conflictPaths,
          message: merged.message
        }
      }
      // Finding 7: a real commit now exists in the integration worktree.
      // Every path below either journals it durably and/or resets the
      // worktree back to baseSha; if none of them get to run because of an
      // unexpected exception, the catch-all must still know to attempt that
      // reset before it may treat the operation as cleanly aborted.
      mergedBaseShaPendingCleanup = baseSha

      // 5. The second journal write, and it happens HERE — immediately after
      //    the merge produces a commit, before the test phase, before tests
      //    run, before anything else can happen. The result sha did not
      //    exist until step 4 just above, and the instant it exists it must
      //    be durable: if the process dies one line from now, restart must
      //    see a 'merged' entry, not silence. The rule this file exists to
      //    keep is "the record precedes the next effect, always" — never
      //    "the record precedes the effect it happens to be convenient to
      //    write next to". Writing this after tests (as a prior version of
      //    this file did) left a real crash window: merge succeeds, process
      //    dies before any durable write carries resultSha, restart finds
      //    only 'intent', a clean worktree, no MERGE_HEAD, and the
      //    classifier returns not-started for a merge that actually
      //    happened. This write closes that window; the write below for
      //    'tests' closes the next one the same way.
      try {
        write('merged', merged.resultSha)
      } catch (error) {
        // Finding 6: lane.status was set to 'publishing' just above, before
        // the merge ran. If this write cannot be made durable, publication
        // stops here -- but nothing past this point ever runs to move the
        // lane out of 'publishing', so it would show as perpetually
        // in-progress. The merge commit is real and unrecorded; that is a
        // human-attention condition, not a transient one.
        const message = error instanceof Error ? error.message : String(error)
        // Finding 7: a failed reset here must be visible, not silently
        // swallowed while the caller believes the worktree went back to
        // baseSha.
        const resetFailure = await tryResetIntegrationTo(baseSha)
        const fullMessage = resetFailure
          ? `${message}; additionally failed to reset the integration worktree: ${resetFailure}`
          : message
        lane.status = 'blocked'
        // Fix 5: worded so it is accurate whether or not the reset above
        // succeeded — when it did, the merge commit is no longer in the
        // worktree, only unrecorded in the journal; when it failed, the
        // commit really is still sitting there.
        lane.blockedReason = resetFailure
          ? `merge commit exists but could not be recorded: ${fullMessage}`
          : `a merge commit could not be recorded (the integration worktree was reset back to base): ${fullMessage}`
        return {
          ok: false,
          reason: 'journal-failed',
          message: fullMessage
        }
      }

      // 6. Test the merge result, not the lane in isolation. The 'tests'
      //    entry is written before runTests() starts, for the same reason:
      //    the record precedes the next effect, always — and, per Finding
      //    3, this write is now fail-closed the same way 'intent' and
      //    'merged' already are: if it cannot be recorded, tests must not
      //    start, because a crash mid-test with no durable 'tests' entry is
      //    exactly the state the classifier reads as merged-unpublished
      //    ("safe to retry the compare-and-swap") instead of
      //    interrupted-tests. Best-effort here would silently reopen that
      //    hole.
      if (settings.test) {
        try {
          write('tests', merged.resultSha)
        } catch (error) {
          // Finding 6: same reasoning as the 'merged' write above -- without
          // this, a durable-write failure here left the lane stuck showing
          // 'publishing' forever, with nothing left in this function to
          // ever move it out.
          const message = error instanceof Error ? error.message : String(error)
          const resetFailure = await tryResetIntegrationTo(baseSha)
          const fullMessage = resetFailure
            ? `${message}; additionally failed to reset the integration worktree: ${resetFailure}`
            : message
          lane.status = 'blocked'
          lane.blockedReason = `merge commit exists but the tests phase could not be recorded: ${fullMessage}`
          return {
            ok: false,
            reason: 'journal-failed',
            message: fullMessage
          }
        }
        const tested = await runTests(settings.integrationWorktree, settings.test)
        if (!tested.ok) {
          lane.status = 'blocked'
          lane.blockedReason = 'tests failed on the merge result'
          // Finding 3: the 'aborted' record here is NOT best-effort, and it
          // is written BEFORE resetIntegrationTo, not after. If the reset
          // ran first and the crash landed in the gap before this write
          // durably landed, restart would see intent+merged+tests against a
          // ref still at baseSha and a worktree already clean — exactly
          // the reality the classifier reads as merged-unpublished, i.e.
          // "safe to republish", for a merge that just failed its tests.
          // Recording the failure before undoing anything closes that
          // window; if the record itself cannot be made durable, the reset
          // must not run either, and both failures are reported together so
          // neither is masked — per the atomicity rule, this propagates the
          // original failure (tests failed) and appends what needs manual
          // attention, rather than silently continuing as the old
          // best-effort write did.
          try {
            write('aborted', merged.resultSha, 'tests failed')
          } catch (writeError) {
            const writeMessage = writeError instanceof Error ? writeError.message : String(writeError)
            lane.blockedReason =
              `tests failed on the merge result, and the failure could not be recorded ` +
              `(${writeMessage}); integration worktree at ${settings.integrationWorktree} needs manual attention`
            return {
              ok: false,
              reason: 'journal-failed',
              message:
                `tests failed on the merge result (${tested.output}); ` +
                `additionally failed to record the abort: ${writeMessage}`
            }
          }
          const resetFailure = await tryResetIntegrationTo(baseSha)
          if (resetFailure) {
            // Finding 7: the 'aborted' record above is already honest (tests
            // really did fail, the journal is correctly closed) — a failed
            // physical cleanup afterward doesn't change that classification,
            // but it must still reach the human, not vanish silently.
            lane.blockedReason =
              `tests failed on the merge result, and the integration worktree could not be ` +
              `reset afterward (${resetFailure}); ${settings.integrationWorktree} needs manual attention`
          }
          return { ok: false, reason: 'tests-failed', output: tested.output }
        }
      }

      // 7 & 8. Worktree check then compare-and-swap, both inside publish().
      const published = await lanes.publish(merged.resultSha, baseSha)
      if (!published.ok) {
        lane.status = 'blocked'
        lane.blockedReason = published.message
        safeWrite(write, 'aborted', merged.resultSha, published.message)
        return { ok: false, reason: published.reason, message: published.message }
      }

      // 9. Record completion before any dependent effect.
      safeWrite(write, 'published', published.commit)
      // 10. Phase 1 has no bulletins to send; recording the step keeps the
      //     journal's shape identical to Phase 2's, so recovery is unchanged.
      safeWrite(write, 'notified', published.commit)

      lane.status = 'working'
      lane.blockedReason = undefined
      return {
        ok: true,
        commit: published.commit,
        touchedPaths: published.touchedPaths,
        warnings
      }
    } catch (error) {
      const originalMessage = error instanceof Error ? error.message : String(error)
      let finalMessage = originalMessage
      // Finding 7 / re-review: a merge commit exists in the integration
      // worktree but nothing on the path we were on got to reset or journal
      // it before this exception fired. Attempt the worktree cleanup here
      // for tidiness, but — critically — resetting the *worktree* says
      // nothing about whether the *branch ref* moved: lanes.publish() can
      // throw AFTER its compare-and-swap already succeeded (its own
      // rollback attempt also failed — see lanes.ts), in which case
      // integrationBranch genuinely points at the merge result no matter
      // what tryResetIntegrationTo() does to the detached worktree HEAD.
      // Once a merge commit exists for this operation
      // (mergedBaseShaPendingCleanup !== undefined), this catch-all must
      // never write 'aborted' — classifyOperation treats 'aborted' as
      // unconditionally 'complete' (see conductor-recovery.ts), so writing
      // it here could falsely close an operation that actually published.
      // Leaving the journal exactly as it stands (at most: intent, merged,
      // maybe tests) lets classifyOperation derive the truth from git
      // reality instead: published-unrecorded if the ref moved,
      // merged-unpublished/interrupted-tests if it did not.
      let safeToRecordAborted = mergedBaseShaPendingCleanup === undefined
      if (mergedBaseShaPendingCleanup !== undefined) {
        const resetFailure = await tryResetIntegrationTo(mergedBaseShaPendingCleanup)
        if (resetFailure) {
          finalMessage =
            `${originalMessage}; additionally, the integration worktree at ` +
            `${settings.integrationWorktree} could not be reset and needs manual attention (${resetFailure})`
        }
      }
      if (journalledIntent && safeToRecordAborted) {
        try {
          journal.append({
            opId, laneId: lane.id, phase: 'aborted',
            baseSha: '', laneTip: '', at: now(),
            detail: finalMessage
          })
        } catch { /* the journal is already the thing that failed */ }
      }
      lane.status = 'blocked'
      lane.blockedReason = finalMessage
      return {
        ok: false,
        reason: 'error',
        message: finalMessage
      }
    } finally {
      // 11. Released on EVERY exit path, and only here — every lane-manager
      //     call above bottoms out in runSupervised, which resolves on the
      //     child's 'close' event, i.e. confirmed exit. Releasing earlier
      //     would be a double-grant, and the next lane would meet index.lock
      //     or a moving ref.
      publishing = null
    }
  }

  // An abort record is best-effort: the operation has already failed, and
  // throwing here would replace a precise failure with a vague one.
  function safeWrite(
    write: (phase: JournalPhase, resultSha?: string, detail?: string) => void,
    phase: JournalPhase,
    resultSha?: string,
    detail?: string
  ): void {
    try {
      write(phase, resultSha, detail)
    } catch (error) {
      console.warn('[crew] conductor journal write failed:', error)
    }
  }

  const resetIntegrationTo = async (sha: string): Promise<void> => {
    // Finding 7: both git invocations' exit codes were previously ignored.
    // A failed reset/clean left the integration worktree in an unknown,
    // possibly still-merged-or-dirty state while every caller proceeded as
    // though the worktree had cleanly returned to `sha` — including the
    // generic catch-all below, which used to record a plain 'aborted' entry
    // regardless. classifyOperation treats 'aborted' as unconditionally
    // 'complete' (see conductor-recovery.ts), so a failed reset recorded
    // that way is a false "nothing to reconcile" for a worktree that may
    // still hold an unrecorded merge commit, or — in the specific case
    // where a post-CAS rollback in lanes.publish() also failed — a ref that
    // genuinely moved. Callers must check for this throw and must not
    // journal 'aborted' when it fires.
    const reset = await runGit(['reset', '--hard', sha], { cwd: settings.integrationWorktree })
    if (reset.code !== 0) {
      throw new Error(
        `git reset --hard ${sha} failed in ${settings.integrationWorktree}: ${reset.stderr.trim() || reset.stdout.trim() || `exit code ${reset.code}`}`
      )
    }
    const clean = await runGit(['clean', '-fd'], { cwd: settings.integrationWorktree })
    if (clean.code !== 0) {
      throw new Error(
        `git clean -fd failed in ${settings.integrationWorktree}: ${clean.stderr.trim() || clean.stdout.trim() || `exit code ${clean.code}`}`
      )
    }
  }

  // Finding 7: every call site below used to `await resetIntegrationTo(...)`
  // bare, ignoring whether it actually succeeded. This wraps it once so a
  // failure is never silently swallowed: it returns the reset's own failure
  // message (or undefined on success) so the caller can fold it into
  // whatever message/detail it was already about to report, rather than
  // proceeding as though the worktree is clean.
  const tryResetIntegrationTo = async (sha: string): Promise<string | undefined> => {
    try {
      await resetIntegrationTo(sha)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  // Gating decision for syncLane and reconcile: RESERVE the same single-flight
  // lock rather than merely rejecting-if-busy, and for the same reason
  // publishLane reserves it — main-thread JavaScript does not serialise
  // across await, so a check made once and never re-asserted only proves
  // "nobody was publishing at this instant", not "nobody starts publishing
  // for the rest of this call". syncLane awaits lanes.facts() (to sample
  // baseSha) and then awaits the merge itself; a publication that starts in
  // either gap would move the ref out from under a baseSha this call has
  // already committed to using, and syncLane would report success against a
  // base that no longer exists. Reserving the lock for the call's whole
  // duration — not just its first line — closes that gap the same way
  // publishLane's reservation does. The alternative (b) — reject outright,
  // reserving nothing — was rejected because a synchronous-only check still
  // leaves every await point after it unguarded; it would move the bug, not
  // fix it. The cost is real and accepted: two syncLane calls, or a syncLane
  // and a reconcile, can no longer run concurrently either, because there is
  // only the one lock in this architecture. That is a throughput loss, not a
  // correctness one, and Phase 1 has no concurrent-sync requirement to trade
  // it away for.
  const syncLane = async (lane: ConductorLane): Promise<SyncOutcome> => {
    // Finding 4: the message used to read "a publication is in flight" even
    // when the lock was actually held by reconcile() or another syncLane —
    // 'busy' does not imply 'publishLane'. `reason: 'busy'` still lets a
    // caller distinguish busy from failed programmatically; only the
    // human-readable text changes here.
    if (publishing !== null) return { ok: false, reason: 'busy', message: 'conductor is busy' }
    publishing = lane.id
    try {
      const facts = await lanes.facts(lane)
      const merged = await lanes.syncLane(lane, facts.baseSha)
      if (!merged.ok) {
        return {
          ok: false,
          reason: 'conflict',
          conflictPaths: merged.conflictPaths,
          message: merged.message
        }
      }
      return { ok: true, resultSha: merged.resultSha, fastForward: merged.fastForward }
    } finally {
      // Released on every exit path — success, conflict, or a thrown
      // GitError — the same rule publishLane's own finally follows.
      publishing = null
    }
  }

  const reconcile = async (): Promise<ReconcileReport> => {
    // Gated synchronously, before journal.read() even runs, let alone the
    // first await below. reconcile() reads the journal and then asks git for
    // the integration branch's ref, MERGE_HEAD, and worktree status — four
    // separate observations that must describe ONE consistent moment. A
    // publication running concurrently mutates exactly those things (moves
    // the ref, writes journal entries, changes MERGE_HEAD, dirties the
    // worktree) between reconcile's reads, which would hand classifyOperation
    // a torn snapshot — e.g. a journal already updated past 'published' but a
    // ref rev-parse taken before the CAS landed — and produce a wrong
    // classification. Reserving the lock, as syncLane now does, is the fix;
    // see the longer comment above syncLane for why reject-and-leave-nothing-
    // reserved is not sufficient once a routine has more than one await.
    if (publishing !== null) throw new ConductorBusyError()
    publishing = 'reconcile'
    try {
      return await reconcileLocked()
    } finally {
      publishing = null
    }
  }

  const reconcileLocked = async (): Promise<ReconcileReport> => {
    const entries = journal.read()
    if (entries.length === 0) return { needsAttention: false, operations: [] }

    const refSha = (await runGit(['rev-parse', settings.integrationBranch], { cwd: settings.repo }))
      .stdout.trim()
    const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      cwd: settings.integrationWorktree
    })
    const status = await runGit(['status', '--porcelain', '--untracked-files=no'], {
      cwd: settings.integrationWorktree
    })
    // Finding 2: the integration worktree is permanently detached, so its own
    // HEAD can be ahead of integrationBranch even when nothing is wrong
    // (mergeInIntegration() commits there before the CAS ever runs). Reading
    // it here is what lets classifyOperation tell "a merge commit exists
    // with no journal record of it" apart from "nothing happened at all".
    const integrationHead = await runGit(['rev-parse', 'HEAD'], { cwd: settings.integrationWorktree })
    const reality = {
      refSha,
      mergeHeadPresent: mergeHead.code === 0 && mergeHead.stdout.trim().length > 0,
      integrationDirty: status.stdout.trim().length > 0,
      integrationHeadSha: integrationHead.stdout.trim()
    }

    const byOp = new Map<string, typeof entries>()
    for (const entry of entries) {
      const list = byOp.get(entry.opId) ?? []
      list.push(entry)
      byOp.set(entry.opId, list)
    }

    // Finding 2 / re-review Fix 3: only one operation can be in flight at a
    // time, so a crashed operation that never received a closing entry
    // (aborted, notified, or a published/moved ref) is not "still open"
    // forever -- it is simply the operation that was running before the
    // last one that actually finished. Reality (refSha, MERGE_HEAD,
    // worktree state) is always read fresh against *today's* git state, so
    // classifying every opId in the journal's retained window (up to
    // JOURNAL_MAX_ENTRIES) against that same reality means a stale crashed
    // op's baseSha no longer matches anything current once a later op has
    // since published successfully -- and it would be permanently
    // misclassified as 'externally-modified', a false "needs a human" alert
    // that never clears and drowns out real ones. Only the operation with
    // the most recent journal entry can still be in flight (or need
    // recovery); every older opId is history and must not be reclassified
    // against reality that was never its own.
    //
    // Selection is by the opId of the LAST entry in `entries`, not by
    // scanning for the largest `at` timestamp: `entries` is already in
    // write order (journal.append()/read() never reorder), so the last
    // entry IS the most recently written one by construction. A
    // timestamp-based `>` scan is not equivalent -- a backwards clock step
    // could make an older write look newest, and a same-millisecond tie
    // keeps whichever opId the `>` comparison saw first (the older one),
    // silently hiding the operation that was actually written last.
    const latestOpId: string | null = entries.length > 0 ? entries[entries.length - 1].opId : null
    const latestGroup = latestOpId !== null ? byOp.get(latestOpId)! : []


    const operations: ReconciledOperation[] = []
    if (latestOpId !== null) {
      const opId = latestOpId
      const group = latestGroup
      // classifyOperation throws MalformedJournalError (mixed opIds,
      // conflicting baseSha/resultSha, duplicate phases) rather than
      // returning a classification. That must never crash reconcile() and
      // must never be swallowed into "nothing happened" — either of those
      // would let a double-apply of the group's merge slip through
      // unnoticed. There is no dedicated Classification member for
      // "malformed" (the union is fixed by src/shared/conductor.ts and this
      // task does not extend it), so it is surfaced using the closest
      // existing member, 'externally-modified': both mean "stopped, this
      // needs a human, never safe to redo automatically" — with a summary
      // that names the real cause so the human is not misled into thinking
      // the ref moved.
      let classification: ReconciledOperation['classification'] | undefined
      try {
        classification = classifyOperation(group, reality)
      } catch (error) {
        if (!(error instanceof MalformedJournalError)) throw error
        operations.push({
          opId,
          laneId: group[0].laneId,
          classification: 'externally-modified',
          summary: `Journal entries for this operation are malformed and cannot be trusted: ${error.message}`,
          safeToRedo: false,
          requiresHuman: true
        })
      }
      if (classification !== undefined && classification !== 'complete') {
        const action = RECOVERY_ACTIONS[classification]
        operations.push({
          opId,
          laneId: group[0].laneId,
          classification,
          summary: action.summary,
          safeToRedo: action.safeToRedo,
          requiresHuman: action.requiresHuman
        })
      }
    }

    // Reports only. A run never auto-resumes, and "cleared lock field" is
    // never evidence that the last operation failed.
    return { needsAttention: operations.length > 0, operations }
  }

  return { publishLane, syncLane, isPublishing, lockHolder, reserveLock, releaseLock, reconcile }
}
