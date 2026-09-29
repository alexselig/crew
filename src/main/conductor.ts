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
  reconcile(): Promise<ReconcileReport>
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

  const publishLane = async (lane: ConductorLane): Promise<PublishOutcome> => {
    if (publishing !== null) return { ok: false, reason: 'busy' }
    publishing = lane.id

    const opId = newOpId()
    let journalledIntent = false

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

      // 5. Test the merge result, not the lane in isolation.
      if (settings.test) {
        safeWrite(write, 'tests', merged.resultSha)
        const tested = await runTests(settings.integrationWorktree, settings.test)
        if (!tested.ok) {
          lane.status = 'blocked'
          lane.blockedReason = 'tests failed on the merge result'
          await resetIntegrationTo(baseSha)
          safeWrite(write, 'aborted', merged.resultSha, 'tests failed')
          return { ok: false, reason: 'tests-failed', output: tested.output }
        }
      }

      // 6. The second journal write. The result SHA did not exist until step 4.
      try {
        write('merged', merged.resultSha)
      } catch (error) {
        await resetIntegrationTo(baseSha)
        return {
          ok: false,
          reason: 'journal-failed',
          message: error instanceof Error ? error.message : String(error)
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
      if (journalledIntent) {
        try {
          journal.append({
            opId, laneId: lane.id, phase: 'aborted',
            baseSha: '', laneTip: '', at: now(),
            detail: error instanceof Error ? error.message : String(error)
          })
        } catch { /* the journal is already the thing that failed */ }
      }
      lane.status = 'blocked'
      lane.blockedReason = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error)
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
    await runGit(['reset', '--hard', sha], { cwd: settings.integrationWorktree })
    await runGit(['clean', '-fd'], { cwd: settings.integrationWorktree })
  }

  const syncLane = async (lane: ConductorLane): Promise<SyncOutcome> => {
    if (publishing !== null) return { ok: false, reason: 'busy', message: 'a publication is in flight' }
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
  }

  const reconcile = async (): Promise<ReconcileReport> => {
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
    const reality = {
      refSha,
      mergeHeadPresent: mergeHead.code === 0 && mergeHead.stdout.trim().length > 0,
      integrationDirty: status.stdout.trim().length > 0
    }

    const byOp = new Map<string, typeof entries>()
    for (const entry of entries) {
      const list = byOp.get(entry.opId) ?? []
      list.push(entry)
      byOp.set(entry.opId, list)
    }

    const operations: ReconciledOperation[] = []
    for (const [opId, group] of byOp) {
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
      let classification: ReconciledOperation['classification']
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
        continue
      }
      if (classification === 'complete') continue
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

    // Reports only. A run never auto-resumes, and "cleared lock field" is
    // never evidence that the last operation failed.
    return { needsAttention: operations.length > 0, operations }
  }

  return { publishLane, syncLane, isPublishing, reconcile }
}
