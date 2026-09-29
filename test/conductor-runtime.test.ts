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
    const classification = classifyOperation(midFlightEntries! as RecoveryJournalEntry[], {
      refSha,
      mergeHeadPresent,
      integrationDirty: status.trim().length > 0
    })
    // Load-bearing: the wrong answer here (not-started) is exactly the bug
    // Finding 1 describes — a merge that happened, misclassified as one
    // that never started.
    expect(classification).not.toBe('not-started')

    releaseTests?.()
    const outcome = await publishPromise
    expect(outcome.ok).toBe(true)
  })
})
