import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import { createJournal } from '../src/main/conductor-journal'
import { createConductor, ConductorBusyError } from '../src/main/conductor'
import { classifyOperation } from '../src/shared/conductor-recovery'
import type { RecoveryJournalEntry } from '../src/shared/conductor-recovery'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings
let journalPath: string

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e'
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } }).trim()
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body)
  git(['add', '.'], cwd)
  git(['commit', '-m', message], cwd)
}

function build() {
  const lanes = createLaneManager(settings)
  const journal = createJournal(journalPath)
  return { lanes, journal, conductor: createConductor({ lanes, journal, settings }) }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-conductor-'))
  journalPath = join(root, 'journal.json')
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  commit(repo, 'README.md', 'base\n', 'base')
  git(['branch', 'crew/integration'], repo)
  settings = {
    repo,
    integrationBranch: 'crew/integration',
    integrationWorktree: join(root, 'integration'),
    lanesDir: join(root, 'lanes'),
    maxLanes: 2,
    test: null
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('publishLane', () => {
  it('publishes a lane and advances the integration branch', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const outcome = await conductor.publishLane(lane)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(outcome.commit)
    }
    expect(conductor.isPublishing()).toBe(false)
  })

  it('writes intent, merged, published and notified to the journal in order', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    await conductor.publishLane(lane)

    const phases = journal.read().map((e) => e.phase)
    expect(phases).toEqual(['intent', 'merged', 'published', 'notified'])
    // The result SHA is not knowable before the merge runs, which is exactly
    // why intent and result are two separate writes.
    expect(journal.read()[0].resultSha).toBeUndefined()
    expect(journal.read()[1].resultSha).toBeTruthy()
  })

  it('treats nothing-to-publish as idle, not an error', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    const outcome = await conductor.publishLane(lane)
    expect(outcome).toMatchObject({ ok: false, reason: 'nothing-to-publish' })
    expect(journal.read()).toHaveLength(0)
  })

  // Main-thread JavaScript does not serialise across await, so the lock must
  // be taken before the first one.
  it('admits exactly one publication when two start in the same tick', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'a.txt', 'A\n', 'a work')
    commit(b.worktree, 'b.txt', 'B\n', 'b work')

    const [first, second] = await Promise.all([
      conductor.publishLane(a),
      conductor.publishLane(b)
    ])
    const outcomes = [first, second]
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1)
    expect(outcomes.filter((o) => !o.ok && o.reason === 'busy')).toHaveLength(1)
    expect(conductor.isPublishing()).toBe(false)
  })

  it('releases the lock after a conflict so the next lane is not starved', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'shared.txt', 'A\n', 'a work')
    commit(b.worktree, 'shared.txt', 'B\n', 'b work')

    expect((await conductor.publishLane(a)).ok).toBe(true)
    const conflicted = await conductor.publishLane(b)
    expect(conflicted).toMatchObject({ ok: false, reason: 'conflict' })
    if (!conflicted.ok && conflicted.reason === 'conflict') {
      expect(conflicted.conflictPaths).toContain('shared.txt')
    }
    expect(conductor.isPublishing()).toBe(false)
    expect(b.status).toBe('blocked')
    expect(b.blockedReason).toBeTruthy()
  })

  it('leaves no merge state behind after a conflict', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'shared.txt', 'A\n', 'a work')
    commit(b.worktree, 'shared.txt', 'B\n', 'b work')
    await conductor.publishLane(a)
    await conductor.publishLane(b)
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toBe('')
  })

  // Publication freezes a commit, so an uncommitted tree cannot contaminate it.
  it('publishes a lane with uncommitted and untracked files, warning only', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    writeFileSync(join(lane.worktree, 'a.txt'), 'uncommitted\n')
    writeFileSync(join(lane.worktree, 'scratch.log'), 'noise\n')

    const outcome = await conductor.publishLane(lane)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.warnings).toContain('uncommitted-tracked-changes')
      expect(outcome.warnings).toContain('untracked-files')
      // The frozen commit's content, not the working tree's.
      expect(git(['show', `${outcome.commit}:a.txt`], settings.repo)).toBe('one')
    }
  })

  it('blocks the lane and leaves the ref alone when the test recipe fails', async () => {
    const { lanes, conductor } = build()
    settings.test = { command: 'sh', args: ['-c', 'exit 1'], cwd: '.', timeoutMs: 10_000 }
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const before = git(['rev-parse', 'crew/integration'], settings.repo)

    const outcome = await conductor.publishLane(lane)
    expect(outcome).toMatchObject({ ok: false, reason: 'tests-failed' })
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
    expect(lane.status).toBe('blocked')
    expect(conductor.isPublishing()).toBe(false)
  })

  it('publishes when the test recipe passes', async () => {
    const { lanes, conductor } = build()
    settings.test = { command: 'sh', args: ['-c', 'exit 0'], cwd: '.', timeoutMs: 10_000 }
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    expect((await conductor.publishLane(lane)).ok).toBe(true)
  })

  // Persistence failure must fail closed and prevent the effect.
  it('aborts before touching git when the journal cannot be written', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const before = git(['rev-parse', 'crew/integration'], settings.repo)

    chmodSync(root, 0o500)
    try {
      const outcome = await conductor.publishLane(lane)
      expect(outcome).toMatchObject({ ok: false, reason: 'journal-failed' })
    } finally {
      chmodSync(root, 0o700)
    }
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
    expect(conductor.isPublishing()).toBe(false)
  })

  // Finding 1: newOpId() used to run AFTER the lock was acquired but BEFORE
  // the try/finally that releases it. A throw there left `publishing` set
  // forever, refusing every later publishLane/syncLane/reconcile. Forcing
  // the throw in exactly that gap and then proving the lock is free
  // afterwards is the only way to catch a regression back to that ordering
  // — this fails against the pre-fix code, where isPublishing() stays true
  // and the second publishLane call below returns { reason: 'busy' } forever
  // instead of succeeding.
  it('releases the lock (never acquires it) when newOpId throws before the try/finally', async () => {
    const lanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    let shouldThrow = true
    const conductor = createConductor({
      lanes, journal, settings,
      newOpId: () => {
        if (shouldThrow) {
          shouldThrow = false
          throw new Error('newOpId boom')
        }
        return 'op-recovered'
      }
    })
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const failed = await conductor.publishLane(lane)
    expect(failed.ok).toBe(false)
    expect(journal.read()).toHaveLength(0)
    // Load-bearing: on the pre-fix ordering this is `true` (stuck) and the
    // retry below returns `{ reason: 'busy' }` instead of succeeding.
    expect(conductor.isPublishing()).toBe(false)

    const retried = await conductor.publishLane(lane)
    expect(retried.ok).toBe(true)
    expect(conductor.isPublishing()).toBe(false)
  })

  // Finding 3: the 'tests' journal write used to be best-effort — if it
  // failed, tests ran anyway, so a crash mid-test would be misclassified as
  // merged-unpublished ("safe to redo") rather than interrupted-tests.
  //
  // A prior version of this test chmod'd `root` (the whole journal
  // directory) BEFORE calling publishLane at all. Since 'intent' is the
  // FIRST append the transaction makes (see conductor.ts), that forced the
  // *intent* write to fail, not the tests write — the test passed, but for
  // the wrong reason, and proved nothing about the tests phase specifically
  // (a regression back to best-effort tests writes would never have been
  // caught by it).
  //
  // This version lets 'intent' and 'merged' land normally by wrapping the
  // real journal and only revoking write permission on the journal
  // directory immediately before passing an append with phase: 'tests'
  // through to the real journal — a genuine filesystem failure at exactly
  // the phase under test, not a mock that merely throws. Permissions are
  // restored in a finally so the temp dir is never left unwritable for
  // cleanup, and so 'aborted'/other later writes the test doesn't expect
  // are not silently swallowed either.
  //
  // Load-bearing: on the pre-fix best-effort write, `testsRan` below
  // becomes `true` and the outcome is `{ reason: 'tests-failed' }` (the
  // injected runTests below always fails) instead of `journal-failed` with
  // the test never invoked.
  it('fails closed and never runs tests when the tests-phase journal write cannot be made durable', async () => {
    const lanes = createLaneManager(settings)
    const realJournal = createJournal(journalPath)
    const journal = {
      read: () => realJournal.read(),
      entriesFor: (opId: string) => realJournal.entriesFor(opId),
      append: (entry: Parameters<typeof realJournal.append>[0]) => {
        if (entry.phase !== 'tests') {
          realJournal.append(entry)
          return
        }
        chmodSync(root, 0o500)
        try {
          realJournal.append(entry)
        } finally {
          chmodSync(root, 0o700)
        }
      }
    }
    let testsRan = false
    settings.test = { command: 'sh', args: ['-c', 'exit 1'], cwd: '.', timeoutMs: 10_000 }
    const conductor = createConductor({
      lanes, journal, settings,
      runTests: async () => {
        testsRan = true
        return { ok: false, output: 'should never run' }
      }
    })
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const before = git(['rev-parse', 'crew/integration'], settings.repo)

    const outcome = await conductor.publishLane(lane)

    expect(outcome).toMatchObject({ ok: false, reason: 'journal-failed' })
    expect(testsRan).toBe(false)
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
    expect(conductor.isPublishing()).toBe(false)
    const phases = realJournal.read().map((e) => e.phase)
    expect(phases).toContain('intent')
    expect(phases).toContain('merged')
    expect(phases).not.toContain('tests')
  })

  // Finding 3 (aborted-write half): the 'aborted' record for a genuine
  // tests-failed outcome is no longer best-effort either. Forcing THAT
  // write to fail must abort before the integration worktree is reset, and
  // the returned message must carry both failures — the original
  // tests-failed cause and the fact the abort could not be recorded — per
  // the atomicity convention (propagate the original error, never mask it
  // with a cleanup error).
  it('fails closed on the aborted-write for a genuine test failure and reports both failures', async () => {
    const lanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    settings.test = { command: 'sh', args: ['-c', 'exit 1'], cwd: '.', timeoutMs: 10_000 }
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    // Let 'intent', 'merged' and 'tests' land normally (they must, or tests
    // would never run at all — see the previous test), then make only the
    // 'aborted' append fail by revoking write access right as tests run.
    let testsStarted = false
    const conductor = createConductor({
      lanes, journal, settings,
      runTests: async () => {
        testsStarted = true
        chmodSync(root, 0o500)
        return { ok: false, output: 'deliberate test failure' }
      }
    })

    try {
      const outcome = await conductor.publishLane(lane)
      expect(testsStarted).toBe(true)
      expect(outcome).toMatchObject({ ok: false, reason: 'journal-failed' })
      if (!outcome.ok && outcome.reason === 'journal-failed') {
        // Both halves, per the atomicity convention.
        expect(outcome.message).toMatch(/tests failed/i)
        expect(outcome.message).toMatch(/abort/i)
      }
    } finally {
      chmodSync(root, 0o700)
    }
    expect(conductor.isPublishing()).toBe(false)
  })
})



describe('syncLane', () => {
  it('brings the integration branch into the lane', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'a.txt', 'A\n', 'a work')
    await conductor.publishLane(a)

    expect((await lanes.facts(b)).behind).toBe(1)
    const outcome = await conductor.syncLane(b)
    expect(outcome.ok).toBe(true)
    expect((await lanes.facts(b)).behind).toBe(0)
  })

  // Finding 2: syncLane used to only SAMPLE `publishing` before its own
  // first await and reserve nothing. Main-thread JavaScript does not
  // serialise across await, so the only way to prove the fix is to
  // construct the exact interleaving the lock exists to stop: start
  // syncLane and do NOT await it before starting publishLane. If syncLane
  // still only sampled the lock, its synchronous prefix would find
  // `publishing === null`, return without reserving anything, and
  // publishLane's own synchronous prefix (invoked next, still before
  // syncLane's first await settles) would ALSO find the lock free and
  // proceed — both operations now running unsynchronized against a base
  // that publishLane is about to move. With the fix, syncLane reserves the
  // lock synchronously before yielding, so publishLane's synchronous check
  // finds it held and refuses immediately.
  it('publishLane refuses while syncLane holds the lock, closing the stale-base race', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'a.txt', 'A\n', 'a work')

    // Deliberately not awaited: this line only runs syncLane's synchronous
    // prefix (its lock check/reservation) before control returns here.
    const syncPromise = conductor.syncLane(b)
    // Load-bearing: fails on the reverted code, where this resolves `ok:
    // true` instead, because the interleaving above raced unsynchronized.
    const publishOutcome = await conductor.publishLane(a)
    expect(publishOutcome).toMatchObject({ ok: false, reason: 'busy' })

    const syncOutcome = await syncPromise
    expect(syncOutcome.ok).toBe(true)
    expect(conductor.isPublishing()).toBe(false)

    // The lock was released cleanly, so a real publish can still land after.
    const published = await conductor.publishLane(a)
    expect(published.ok).toBe(true)
  })

  it('reconcile refuses while a publish holds the lock, and the lock is free again once it settles', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const publishPromise = conductor.publishLane(lane)
    await expect(conductor.reconcile()).rejects.toBeInstanceOf(ConductorBusyError)

    expect((await publishPromise).ok).toBe(true)
    await expect(conductor.reconcile()).resolves.toMatchObject({ needsAttention: false })
  })

  // Finding 4: syncLane's busy message used to always say "a publication is
  // in flight" even when the lock was actually held by something else
  // (here, reconcile()). Load-bearing on the message text itself — the
  // pre-fix code returns the publication-specific wording even though no
  // publishLane call is involved anywhere in this test.
  it('reports a generic busy message from syncLane when reconcile, not a publish, holds the lock', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    // An empty journal makes reconcile() return almost immediately after
    // acquiring the lock, but the lock is still held synchronously the
    // instant syncLane's own synchronous prefix runs.
    expect(journal.read()).toHaveLength(0)
    const reconcilePromise = conductor.reconcile()
    const syncOutcome = await conductor.syncLane(a)
    expect(syncOutcome).toMatchObject({ ok: false, reason: 'busy' })
    if (!syncOutcome.ok && syncOutcome.reason === 'busy') {
      expect(syncOutcome.message).toBe('conductor is busy')
      expect(syncOutcome.message).not.toMatch(/publication/i)
    }
    await reconcilePromise
  })
})

describe('reconcile', () => {
  it('reports nothing to do for a clean, fully journalled run', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    await conductor.publishLane(lane)

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(false)
    expect(report.operations).toHaveLength(0)
  })

  // Crash between the merge and the CAS: the safest classification to get
  // wrong, because redoing it when it HAD published double-applies the work.
  it('classifies a crash between merge and publish as merged-unpublished', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const facts = await lanes.facts(lane)
    const merged = await lanes.mergeInIntegration(facts.laneTip, facts.baseSha)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    journal.append({
      opId: 'op-crash', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 1
    })
    journal.append({
      opId: 'op-crash', laneId: lane.id, phase: 'merged',
      baseSha: facts.baseSha, laneTip: facts.laneTip, resultSha: merged.resultSha, at: 2
    })

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(true)
    expect(report.operations[0]).toMatchObject({
      opId: 'op-crash',
      classification: 'merged-unpublished'
    })
  })

  // Finding 2: a crash INSIDE the 'merged' append itself, not merely between
  // two completed writes. Only 'intent' is ever journaled — the merge
  // itself really did run and commit in the (permanently detached)
  // integration worktree, but the durable record of it never landed. Before
  // this fix, reconcile() had no way to see that the integration worktree's
  // HEAD had moved past baseSha, so it read the ref unmoved + no MERGE_HEAD
  // + clean worktree as "nothing happened" and classified not-started —
  // silently orphaning a real merge commit and, worse, telling the operator
  // it is safe to just publish again. Load-bearing: reverting the
  // integrationHeadSha plumbing in conductor.ts (or the classifier check
  // that reads it) makes this assert 'not-started' instead.
  it('classifies a crash inside the merged-append itself as needing a human, not not-started', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const facts = await lanes.facts(lane)
    // The real merge really runs and really commits in the integration
    // worktree — this is not a simulation of the commit, only of the
    // journal write that (in production) is supposed to follow it
    // immediately but here never happens.
    const merged = await lanes.mergeInIntegration(facts.laneTip, facts.baseSha)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    journal.append({
      opId: 'op-crash-mid-append', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 1
    })
    // Deliberately no 'merged' entry: this is the crash-during-append window.

    const before = git(['rev-parse', 'crew/integration'], settings.repo)
    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(true)
    expect(report.operations[0]).toMatchObject({
      opId: 'op-crash-mid-append',
      requiresHuman: true,
      safeToRedo: false
    })
    expect(report.operations[0].classification).not.toBe('not-started')
    // reconcile() only reports; the orphaned merge commit and the untouched
    // ref are both left exactly as reconcile found them.
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
  })


  it('classifies an externally moved ref as needing a human', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    journal.append({
      opId: 'op-x', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 1
    })
    commit(settings.repo, 'outside.txt', 'X\n', 'outside')
    git(['update-ref', 'refs/heads/crew/integration', git(['rev-parse', 'HEAD'], settings.repo)], settings.repo)

    const report = await conductor.reconcile()
    expect(report.operations[0].classification).toBe('externally-modified')
    expect(report.operations[0].requiresHuman).toBe(true)
  })

  it('never auto-resumes: reconcile only reports, it does not act', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    const merged = await lanes.mergeInIntegration(facts.laneTip, facts.baseSha)
    if (!merged.ok) return
    journal.append({
      opId: 'op-crash', laneId: lane.id, phase: 'merged',
      baseSha: facts.baseSha, laneTip: facts.laneTip, resultSha: merged.resultSha, at: 1
    })
    const before = git(['rev-parse', 'crew/integration'], settings.repo)
    await conductor.reconcile()
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
  })

  // The classifier now throws MalformedJournalError on malformed input (mixed
  // opIds, conflicting shas, duplicate phases) rather than returning a
  // classification. A crash could leave stray entries from an
  // interrupted-but-partially-written batch; reconcile must surface that as
  // a requires-human operation, never let it crash reconcile() itself, and
  // never silently drop the offending opId as though nothing happened. There
  // is no dedicated Classification member for this (the brief's union is
  // fixed), so it is reported using the existing 'externally-modified' value
  // — the closest existing semantics ("stopped, needs a human, never safe to
  // redo") — with a summary that names the real cause.
  it('surfaces a malformed operation as needing a human instead of throwing', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    // Two conflicting baseSha values for the same opId is not producible by
    // the runtime's own write path; it stands in for "the journal already
    // has a duplicate/contradictory entry when we read it back".
    journal.append({
      opId: 'op-bad', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 1
    })
    journal.append({
      opId: 'op-bad', laneId: lane.id, phase: 'merged',
      baseSha: 'deadbeef', laneTip: facts.laneTip, resultSha: 'cafef00d', at: 2
    })

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(true)
    expect(report.operations).toHaveLength(1)
    expect(report.operations[0]).toMatchObject({
      opId: 'op-bad',
      classification: 'externally-modified',
      requiresHuman: true,
      safeToRedo: false
    })
    expect(report.operations[0].summary).toMatch(/malformed/i)
  })

  // Finding 1: when settings.test is configured, the 'merged' entry (the
  // durable record that a merge commit exists) must be written IMMEDIATELY
  // after the merge succeeds — before the test phase starts, before
  // runTests() is even called. The load-bearing proof is timing, not just
  // final state: this test starts the test phase running, inspects the
  // journal WHILE it is still in flight (using a deps.runTests injection
  // gated by a manually-controlled promise, so there is no wall-clock
  // sleep to race), and requires 'merged' to already be present with a
  // resultSha at that instant. On the reverted code (which wrote 'merged'
  // only in the step after tests pass), this assertion fails: the journal
  // would show only 'intent' and 'tests' while the test phase is running,
  // never 'merged'.
  it('journals the merge before the test phase runs, so a crash mid-test still classifies as a merge that happened', async () => {
    const lanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    let releaseTests: (() => void) | undefined
    const testGate = new Promise<void>((resolve) => { releaseTests = resolve })
    let midFlightEntries: ReturnType<typeof journal.read> | undefined

    settings.test = { command: 'sh', args: ['-c', 'exit 0'], cwd: '.', timeoutMs: 10_000 }
    const conductor = createConductor({
      lanes, journal, settings,
      runTests: async () => {
        // The instant the test phase begins running is exactly the instant
        // a crash "during tests" would leave the journal in. Capture it here
        // instead of guessing at it from outside.
        midFlightEntries = journal.read()
        await testGate
        return { ok: true, output: '' }
      }
    })

    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const publishPromise = conductor.publishLane(lane)
    // Wait for the (real, subprocess-backed) merge to complete and the test
    // phase's runTests hook to start — polled rather than a fixed sleep,
    // since the merge itself runs through real git subprocesses.
    const deadline = Date.now() + 5000
    while (midFlightEntries === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    expect(midFlightEntries).toBeDefined()
    const phases = midFlightEntries!.map((e) => e.phase)
    // Load-bearing: this is the literal requirement Finding 1 fixes.
    expect(phases).toContain('merged')
    expect(phases).not.toContain('published')
    const mergedEntry = midFlightEntries!.find((e) => e.phase === 'merged')
    expect(mergedEntry?.resultSha).toBeTruthy()

    // Drive the real classifier against exactly this mid-crash journal
    // state plus real git reality captured at the same instant: not the
    // internal `publishing` field, the actual reconciliation table.
    const refSha = git(['rev-parse', settings.integrationBranch], settings.repo)
    let mergeHeadPresent = false
    try {
      mergeHeadPresent = execFileSync(
        'git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
        { cwd: settings.integrationWorktree, encoding: 'utf8' }
      ).trim().length > 0
    } catch {
      mergeHeadPresent = false
    }
    const status = execFileSync(
      'git', ['status', '--porcelain', '--untracked-files=no'],
      { cwd: settings.integrationWorktree, encoding: 'utf8' }
    )
    const integrationHeadSha = git(['rev-parse', 'HEAD'], settings.integrationWorktree)
    const classification = classifyOperation(midFlightEntries! as RecoveryJournalEntry[], {
      refSha,
      mergeHeadPresent,
      integrationDirty: status.trim().length > 0,
      integrationHeadSha
    })
    // Load-bearing: this is exactly Finding 1's classification. Before the
    // fix, integrationDirty (no tracked files touched by `exit 0`) was
    // false, so the buggy `phases.has('tests') && reality.integrationDirty`
    // conjunct fell through to merged-unpublished — "safe to retry the
    // compare-and-swap" — for a merge whose tests were still running. The
    // fixed classifier must read the journaled 'tests' phase alone.
    expect(classification).toBe('interrupted-tests')

    releaseTests?.()
    const outcome = await publishPromise
    expect(outcome.ok).toBe(true)
  })
})
