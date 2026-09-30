import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import { createJournal } from '../src/main/conductor-journal'
import { createConductor, ConductorBusyError } from '../src/main/conductor'
import { createShippedConductorBackend } from '../src/main/conductor-ipc'
import { classifyOperation } from '../src/shared/conductor-recovery'
import type { RecoveryJournalEntry } from '../src/shared/conductor-recovery'
import type { ConductorConfig, ConductorLane, ConductorSettings } from '../src/shared/conductor'
import { createConductorController } from '../src/main/conductor-bootstrap'

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
    expect(conductor.lockHolder()).toBeNull()
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
    expect(conductor.lockHolder()).toBeNull()
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
    expect(conductor.lockHolder()).toBeNull()
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
    expect(conductor.lockHolder()).toBeNull()
  })

  // Finding 7: resetIntegrationTo previously ignored the exit codes of
  // `git reset --hard` / `git clean -fd`, so a failed cleanup after a
  // genuine test failure was silently swallowed — the outcome and
  // blockedReason looked identical to a clean reset, even though the
  // integration worktree may still be sitting on the merge commit. Force a
  // real reset failure by making the integration worktree's own git
  // directory (a linked worktree's `.git` is a file pointing at
  // `<repo>/.git/worktrees/<name>`, not a directory of its own) read-only —
  // the established technique in this suite (see test/lanes-merge.test.ts)
  // for forcing a genuine git failure without mocking anything.
  it('surfaces a failed integration-worktree reset instead of silently swallowing it', async () => {
    const lanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    settings.test = { command: 'sh', args: ['-c', 'exit 1'], cwd: '.', timeoutMs: 10_000 }
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    // Computed BEFORE any chmod, and the merge itself is left to run
    // normally (it needs write access to this same git dir) — only
    // runTests(), invoked after the merge has already committed, revokes
    // permission, so resetIntegrationTo is the thing that fails, not the
    // merge.
    const gitDirOut = git(['rev-parse', '--git-dir'], settings.integrationWorktree)
    const gitDir = isAbsolute(gitDirOut) ? gitDirOut : resolve(settings.integrationWorktree, gitDirOut)
    expect(gitDir).toContain(join('.git', 'worktrees'))

    const conductor = createConductor({
      lanes, journal, settings,
      runTests: async () => {
        chmodSync(gitDir, 0o500)
        return { ok: false, output: 'fails' }
      }
    })

    let outcome: Awaited<ReturnType<typeof conductor.publishLane>> | undefined
    try {
      outcome = await conductor.publishLane(lane)
    } finally {
      chmodSync(gitDir, 0o700)
    }

    expect(outcome).toMatchObject({ ok: false, reason: 'tests-failed' })
    expect(lane.status).toBe('blocked')
    // Load-bearing: on the pre-fix code, this message never mentions the
    // reset at all -- resetIntegrationTo's failed git commands were awaited
    // and their exit codes discarded, so the failure vanished entirely.
    expect(lane.blockedReason).toMatch(/could not be reset/i)
    expect(lane.blockedReason).toMatch(/manual attention/i)
    expect(conductor.lockHolder()).toBeNull()

    // Permissions restored: the worktree can now actually be untangled by
    // hand, proving the failure was real and not a mock.
    git(['reset', '--hard'], settings.integrationWorktree)
  })

  // Finding 7 (second half): the generic catch-all used to write 'aborted'
  // unconditionally, with no attempt to reset the integration worktree at
  // all, whenever an unexpected exception landed after the merge had
  // already produced a commit. classifyOperation treats 'aborted' as
  // unconditionally 'complete' (conductor-recovery.ts), so recording it
  // here for an operation whose worktree was never actually cleaned up (or
  // whose ref, in the post-CAS-rollback-also-failed case, genuinely moved)
  // is a false "nothing to reconcile". Simulate an unexpected exception
  // from lanes.publish() (distinct from its normal `{ ok: false }` return)
  // while the integration worktree's git dir is read-only, so the
  // catch-all's own reset attempt is forced to fail too.
  it('does not record a clean abort when an unexpected error after the merge leaves the reset unable to run', async () => {
    const realLanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    await realLanes.ensureIntegrationWorktree()
    const lane = await realLanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const gitDirOut = git(['rev-parse', '--git-dir'], settings.integrationWorktree)
    const gitDir = isAbsolute(gitDirOut) ? gitDirOut : resolve(settings.integrationWorktree, gitDirOut)

    const lanes = {
      ...realLanes,
      publish: async (): Promise<never> => {
        chmodSync(gitDir, 0o500)
        throw new Error('unexpected failure deep inside publish()')
      }
    }
    const conductor = createConductor({ lanes, journal, settings })

    let outcome: Awaited<ReturnType<typeof conductor.publishLane>> | undefined
    try {
      outcome = await conductor.publishLane(lane)
    } finally {
      chmodSync(gitDir, 0o700)
    }

    expect(outcome).toMatchObject({ ok: false, reason: 'error' })
    expect(lane.status).toBe('blocked')
    expect(lane.blockedReason).toMatch(/manual attention/i)
    // Load-bearing: on the pre-fix code, this phase list contains 'aborted'
    // unconditionally -- the classifier would then read this operation as
    // 'complete' on restart, even though the reset never ran.
    const phases = journal.read().map((e) => e.phase)
    expect(phases).not.toContain('aborted')
    expect(phases).toContain('merged')

    git(['reset', '--hard'], settings.integrationWorktree)
  })

  // Re-review Fix 1: the previous test above proves the catch-all no
  // longer records a false 'aborted' when its own worktree-reset attempt
  // fails. This test proves the narrower, more dangerous case the
  // re-review found: lanes.publish() can throw AFTER its compare-and-swap
  // has ALREADY moved integrationBranch (see lanes.ts's combined
  // "CAS succeeded, rollback also failed" error) — and resetting the
  // *worktree* afterward succeeds cleanly, telling the catch-all nothing
  // about the ref. The pre-fix code only checked whether the reset
  // succeeded, so it still journalled a plain 'aborted' here even though
  // the branch genuinely points at the merge result: reconcile() would
  // then report nothing to reconcile for an operation that actually
  // published, permanently losing that publish from Conductor's own
  // bookkeeping. Simulate this by making the mocked publish() perform a
  // REAL compare-and-swap (so the ref really moves, exactly like
  // lanes.ts's CAS would have) and then throw, with the integration
  // worktree left perfectly clean.
  it('classifies as published-unrecorded, not aborted, when publish() throws after its own CAS already moved the ref', async () => {
    const realLanes = createLaneManager(settings)
    const journal = createJournal(journalPath)
    await realLanes.ensureIntegrationWorktree()
    const lane = await realLanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const lanes = {
      ...realLanes,
      publish: async (newSha: string, expectedOld: string): Promise<never> => {
        // The real CAS: this is exactly what lanes.ts's publish() does
        // before it can go on to throw the combined
        // "compare-and-swap succeeded, rollback also failed" error.
        git(['update-ref', 'refs/heads/crew/integration', newSha, expectedOld], settings.repo)
        throw new Error('rollback also failed: crew/integration needs manual attention')
      }
    }
    const conductor = createConductor({ lanes, journal, settings })

    const outcome = await conductor.publishLane(lane)
    expect(outcome).toMatchObject({ ok: false, reason: 'error' })

    // The branch really did move — this is the fact a plain 'aborted'
    // entry would have hidden from reconcile().
    const merged = journal.read().find((e) => e.phase === 'merged')
    expect(merged?.resultSha).toBeDefined()
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(merged?.resultSha)

    // Load-bearing: on the pre-fix code, a successful worktree reset alone
    // was enough to journal 'aborted' here, which classifyOperation reads
    // as unconditionally 'complete' — reconcile() would report nothing to
    // reconcile for a publish that actually happened.
    const phases = journal.read().map((e) => e.phase)
    expect(phases).not.toContain('aborted')

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(true)
    expect(report.operations[0]).toMatchObject({
      classification: 'published-unrecorded',
      safeToRedo: false
    })
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
    expect(conductor.lockHolder()).toBeNull()
  })

  // Finding 6: when the 'merged' journal write cannot be made durable, the
  // merge commit is real but unrecorded, and nothing else in this function
  // ever runs to move the lane out of 'publishing' (set before the merge
  // step). Before the fix, this left the lane permanently showing
  // "publication in progress" for an operation that had already stopped.
  // Same technique as the 'tests'-write-failure test above: let 'intent'
  // land normally, then revoke write permission on the journal directory
  // only for the append with phase: 'merged', so this is a genuine
  // filesystem failure at exactly the write under test.
  it('blocks the lane, rather than leaving it stuck publishing, when the merged-phase journal write cannot be made durable', async () => {
    const lanes = createLaneManager(settings)
    const realJournal = createJournal(journalPath)
    const journal = {
      read: () => realJournal.read(),
      entriesFor: (opId: string) => realJournal.entriesFor(opId),
      append: (entry: Parameters<typeof realJournal.append>[0]) => {
        if (entry.phase !== 'merged') {
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
    const conductor = createConductor({ lanes, journal, settings })
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const outcome = await conductor.publishLane(lane)

    expect(outcome).toMatchObject({ ok: false, reason: 'journal-failed' })
    expect(conductor.lockHolder()).toBeNull()
    expect(lane.status).toBe('blocked')
    expect(lane.blockedReason).toBeTruthy()
    const phases = realJournal.read().map((e) => e.phase)
    expect(phases).toContain('intent')
    expect(phases).not.toContain('merged')
  })

  // Finding 1: newOpId() used to run AFTER the lock was acquired but BEFORE
  // the try/finally that releases it. A throw there left `publishing` set
  // forever, refusing every later publishLane/syncLane/reconcile. Forcing
  // the throw in exactly that gap and then proving the lock is free
  // afterwards is the only way to catch a regression back to that ordering
  // — this fails against the pre-fix code, where the lock stays held
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
    expect(conductor.lockHolder()).toBeNull()

    const retried = await conductor.publishLane(lane)
    expect(retried.ok).toBe(true)
    expect(conductor.lockHolder()).toBeNull()
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
    expect(conductor.lockHolder()).toBeNull()
    // Finding 6: previously nothing after the failed 'tests' write ever ran
    // to move the lane out of 'publishing' (set before the merge step), so
    // it was stuck showing "in progress" forever for an operation that had
    // already stopped.
    expect(lane.status).toBe('blocked')
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
    expect(conductor.lockHolder()).toBeNull()
  })
}, { timeout: 30_000 })

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
    expect(conductor.lockHolder()).toBeNull()

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

  // Task 5, finding 1: lockHolder() is the single source of truth the
  // backend now reads instead of maintaining its own shadow copy. Load-
  // bearing on lockHolder() actually reflecting the SAME lock
  // publishLane reserves, not a second independent variable.
  it('lockHolder() reports the lane id holding the lock while a publish is in flight, then null once released', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    expect(conductor.lockHolder()).toBeNull()
    const publishPromise = conductor.publishLane(lane)
    expect(conductor.lockHolder()).toBe(lane.id)
    await publishPromise
    expect(conductor.lockHolder()).toBeNull()
  })

  // Task 5, finding 2: destroyLane needs to reserve the SAME lock a publish
  // holds, or a destroy could race a merge reading the same worktree.
  // reserveLock/releaseLock are the primitive that makes that possible for
  // an operation (lane destruction) that isn't itself a publish/sync/
  // reconcile.
  it('reserveLock refuses while the lock is held and lets a later caller take it once released', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const publishPromise = conductor.publishLane(lane)
    expect(conductor.reserveLock('destroy:other')).toBe(false)
    expect(conductor.lockHolder()).toBe(lane.id)
    await publishPromise

    expect(conductor.reserveLock('destroy:other')).toBe(true)
    expect(conductor.lockHolder()).toBe('destroy:other')
    expect(conductor.lockHolder()).not.toBeNull()
    conductor.releaseLock('destroy:other')
    expect(conductor.lockHolder()).toBeNull()
    expect(conductor.lockHolder()).toBeNull()
  })

  // Task 5, finding 1 (fix round 1): releaseLock() used to take no owner at
  // all, so ANY caller could clear ANY other caller's lock. Load-bearing:
  // revert releaseLock to accept no argument and unconditionally clear the
  // lock, and this test fails because the impostor's release would succeed.
  it('releaseLock() from a non-holder is a no-op: the true holder still holds the lock', async () => {
    const { lanes, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const publishPromise = conductor.publishLane(lane)
    expect(conductor.lockHolder()).toBe(lane.id)

    // An impostor that never reserved the lock (or reserved it and lost the
    // race) tries to release it anyway, using a holder string that is not
    // the true holder.
    conductor.releaseLock('impostor')
    expect(conductor.lockHolder()).toBe(lane.id)
    expect(conductor.lockHolder()).not.toBeNull()

    await publishPromise
    expect(conductor.lockHolder()).toBeNull()
  })
}, { timeout: 30_000 })

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

  // Finding 2: a crashed operation never receives a closing entry (no
  // 'aborted'/'notified', and its resultSha never lands on the ref), so it
  // stays in the journal's retained window forever. Once a LATER operation
  // publishes successfully, the ref has moved past the stale op's baseSha —
  // reclassifying the stale op against today's reality would read as
  // 'externally-modified' (its baseSha/resultSha match nothing current),
  // a false "needs a human" alert that never clears and would drown out
  // real ones. Only the most recent operation can still be in flight or
  // need recovery; a closed, superseded stale op must not resurface.
  it('does not resurface a stale crashed operation as needing attention after a later operation publishes successfully', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()

    // Stale crashed operation: merge committed, journal never closed, ref
    // never moved for it — recorded against the repo's ORIGINAL base.
    const staleLane = await lanes.create('stale', { presetId: 'shell', model: null })
    commit(staleLane.worktree, 'stale.txt', 'stale\n', 'stale lane work')
    const staleFacts = await lanes.facts(staleLane)
    const staleMerged = await lanes.mergeInIntegration(staleFacts.laneTip, staleFacts.baseSha)
    expect(staleMerged.ok).toBe(true)
    if (!staleMerged.ok) return
    journal.append({
      opId: 'op-stale', laneId: staleLane.id, phase: 'intent',
      baseSha: staleFacts.baseSha, laneTip: staleFacts.laneTip, at: 1
    })
    journal.append({
      opId: 'op-stale', laneId: staleLane.id, phase: 'merged',
      baseSha: staleFacts.baseSha, laneTip: staleFacts.laneTip, resultSha: staleMerged.resultSha, at: 2
    })
    // Undo the stale merge in the integration worktree so it doesn't
    // interfere with the later real publish below — a real crash would
    // have left this in whatever state the next reconcile/redo handles;
    // what matters for this test is only that the STALE JOURNAL ENTRY
    // persists with no closing record.
    git(['reset', '--hard', staleFacts.baseSha], settings.integrationWorktree)

    // A later, unrelated operation runs to completion normally.
    const goodLane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(goodLane.worktree, 'good.txt', 'good\n', 'good lane work')
    const outcome = await conductor.publishLane(goodLane)
    expect(outcome.ok).toBe(true)

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(false)
    expect(report.operations).toHaveLength(0)
  })

  // Re-review Fix 4: no existing test pinned this direction — an older
  // operation completing cleanly, followed by a newer operation that
  // crashes. The code already handles it (the newest-op selection has
  // always looked at every opId's entries), but nothing proved it.
  it('reports the newest operation as needing attention when an older operation already completed cleanly', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()

    // Older operation: publishes to completion via the real runtime.
    const oldLane = await lanes.create('old', { presetId: 'shell', model: null })
    commit(oldLane.worktree, 'old.txt', 'old\n', 'old lane work')
    const oldOutcome = await conductor.publishLane(oldLane)
    expect(oldOutcome.ok).toBe(true)

    // Newer operation: a real merge commits in the integration worktree,
    // but the journal never receives a closing entry -- a crash between
    // merge and publish, same shape as the 'merged-unpublished' test above.
    const newLane = await lanes.create('new', { presetId: 'shell', model: null })
    commit(newLane.worktree, 'new.txt', 'new\n', 'new lane work')
    const newFacts = await lanes.facts(newLane)
    const newMerged = await lanes.mergeInIntegration(newFacts.laneTip, newFacts.baseSha)
    expect(newMerged.ok).toBe(true)
    if (!newMerged.ok) return
    journal.append({
      opId: 'op-new-crash', laneId: newLane.id, phase: 'intent',
      baseSha: newFacts.baseSha, laneTip: newFacts.laneTip, at: 100
    })
    journal.append({
      opId: 'op-new-crash', laneId: newLane.id, phase: 'merged',
      baseSha: newFacts.baseSha, laneTip: newFacts.laneTip, resultSha: newMerged.resultSha, at: 101
    })

    const report = await conductor.reconcile()
    expect(report.needsAttention).toBe(true)
    expect(report.operations).toHaveLength(1)
    expect(report.operations[0]).toMatchObject({
      opId: 'op-new-crash',
      classification: 'merged-unpublished'
    })
  })

  // Re-review Fix 3: the old selection scanned every entry for the largest
  // `at` timestamp with a strict `>` comparison, so a same-millisecond tie
  // kept whichever opId it saw FIRST while iterating the Map -- i.e. the
  // older one, exactly backwards from "pick the newest". Pin the fix:
  // build a journal where two operations share one timestamp, and the
  // genuinely later-WRITTEN operation (last in write/array order) must
  // still be the one reconcile reports on.
  it('resolves a same-timestamp tie to the later-written operation, not the first one seen', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()

    // Written first, at t=5: a cleanly closed operation (empty SHAs are
    // legal for 'aborted' -- see conductor-journal.ts's validator).
    journal.append({
      opId: 'op-first-written', laneId: 'lane-a', phase: 'aborted',
      baseSha: '', laneTip: '', at: 5, detail: 'closed cleanly'
    })

    // Written second, also at t=5: a real merge commit with no closing
    // entry -- classifies as merged-unpublished, letting the assertion
    // below tell the two operations apart by classification, not just opId.
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    const merged = await lanes.mergeInIntegration(facts.laneTip, facts.baseSha)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    journal.append({
      opId: 'op-second-written', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 5
    })
    journal.append({
      opId: 'op-second-written', laneId: lane.id, phase: 'merged',
      baseSha: facts.baseSha, laneTip: facts.laneTip, resultSha: merged.resultSha, at: 5
    })

    const report = await conductor.reconcile()
    // Load-bearing: the pre-fix `e.at > latestAt` scan keeps 'op-first-written'
    // here, because it is seen first and 5 is never STRICTLY greater than 5
    // for the second operation's entries.
    expect(report.needsAttention).toBe(true)
    expect(report.operations).toHaveLength(1)
    expect(report.operations[0]).toMatchObject({
      opId: 'op-second-written',
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
}, { timeout: 30_000 })

// ── Re-review finding I-1: the needs-attention gate must have an exit ──
// Every test shipped before this one proved only that the gate CLOSES.
// classifyOperation returns 'complete' as soon as an operation carries an
// 'aborted' or 'notified' entry, and until now nothing in the product ever
// wrote one — so a single interrupted operation shut publish and sync for
// that workspace permanently, with no control, no command and no code path
// that could reopen them. These tests drive the real journal on disk and
// real git, and assert the gate REOPENS.
describe('acknowledgeOperation (the needs-attention gate\'s only exit)', () => {
  // The state a crash leaves behind: an operation that recorded its intent
  // and then never came back.
  async function interruptedOperation() {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    journal.append({
      opId: 'op-crash', laneId: lane.id, phase: 'intent',
      baseSha: facts.baseSha, laneTip: facts.laneTip, at: 1
    })
    return { lanes, journal, conductor, lane }
  }

  it('reopens a gate that a crashed operation had closed', async () => {
    const { journal, conductor } = await interruptedOperation()

    const before = await conductor.reconcile()
    expect(before.needsAttention).toBe(true)
    expect(before.operations[0].opId).toBe('op-crash')

    const outcome = await conductor.acknowledgeOperation('op-crash', 'reviewed: nothing had run')
    expect(outcome).toMatchObject({ ok: true })
    if (!outcome.ok) return

    // The gate is open in the report acknowledge itself returns…
    expect(outcome.report.needsAttention).toBe(false)
    // …and on a fresh, independent read of the journal on disk, which is
    // what a restart would do.
    const after = await conductor.reconcile()
    expect(after.needsAttention).toBe(false)
    expect(after.operations).toHaveLength(0)
    expect(createJournal(journalPath).read().some((e) => e.phase === 'aborted')).toBe(true)
    expect(journal.read().at(-1)).toMatchObject({ opId: 'op-crash', phase: 'aborted' })
  })

  // The acknowledgement is itself a journal record, not a flag in memory:
  // an unreviewed interrupted operation must never be silently overwritten,
  // and the record must say a human did it and why.
  it('records who closed the operation and with what note, durably', async () => {
    const { conductor } = await interruptedOperation()
    await conductor.reconcile()
    await conductor.acknowledgeOperation('op-crash', 'reviewed: nothing had run')

    const entry = createJournal(journalPath).read().at(-1)!
    expect(entry.phase).toBe('aborted')
    expect(entry.detail).toContain('reviewed: nothing had run')
  })

  // A publish that DID land must be closed as 'notified', not 'aborted' —
  // the two mean opposite things to anyone reading the journal afterwards.
  it('closes an operation that had already published as notified, not aborted', async () => {
    const { lanes, journal, conductor } = build()
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const facts = await lanes.facts(lane)
    const merged = await lanes.mergeInIntegration(facts.laneTip, facts.baseSha)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    for (const [phase, at] of [['intent', 1], ['merged', 2], ['published', 3]] as const) {
      journal.append({
        opId: 'op-half', laneId: lane.id, phase,
        baseSha: facts.baseSha, laneTip: facts.laneTip,
        resultSha: phase === 'intent' ? undefined : merged.resultSha, at
      })
    }

    await conductor.reconcile()
    const outcome = await conductor.acknowledgeOperation('op-half', 'confirmed the merge landed')
    expect(outcome).toMatchObject({ ok: true, phase: 'notified' })
    expect(journal.read().at(-1)).toMatchObject({ opId: 'op-half', phase: 'notified' })
  })

  it('refuses an operation that is not the one reconcile reported, rather than closing the wrong one', async () => {
    const { journal, conductor } = await interruptedOperation()
    await conductor.reconcile()

    const outcome = await conductor.acknowledgeOperation('op-some-other', 'oops')
    expect(outcome).toMatchObject({ ok: false, reason: 'stale' })
    // Nothing was written, so the real operation is still outstanding.
    expect(journal.read().map((e) => e.phase)).toEqual(['intent'])
    expect((await conductor.reconcile()).needsAttention).toBe(true)
  })

  it('refuses to close an operation twice', async () => {
    const { journal, conductor } = await interruptedOperation()
    await conductor.reconcile()
    await conductor.acknowledgeOperation('op-crash', 'reviewed')
    const again = await conductor.acknowledgeOperation('op-crash', 'reviewed again')
    expect(again).toMatchObject({ ok: false, reason: 'already-closed' })
    // A duplicate phase for one opId makes classifyOperation throw, so a
    // second write here would corrupt the journal outright.
    expect(journal.read().filter((e) => e.phase === 'aborted')).toHaveLength(1)
  })

  it('refuses while a publication holds the single-flight lock', async () => {
    const { conductor } = await interruptedOperation()
    await conductor.reconcile()
    expect(conductor.reserveLock('someone-else')).toBe(true)
    try {
      await expect(conductor.acknowledgeOperation('op-crash', 'reviewed'))
        .resolves.toMatchObject({ ok: false, reason: 'busy' })
    } finally {
      conductor.releaseLock('someone-else')
    }
    // …and the lock it did not take is still the other holder's.
    expect(conductor.lockHolder()).toBeNull()
  })

  it('leaves nothing acknowledged when the journal write fails', async () => {
    const { lanes, conductor } = await interruptedOperation()
    expect(lanes).toBeDefined()
    await conductor.reconcile()
    chmodSync(root, 0o500)
    let outcome: Awaited<ReturnType<typeof conductor.acknowledgeOperation>>
    try {
      outcome = await conductor.acknowledgeOperation('op-crash', 'reviewed')
    } finally {
      chmodSync(root, 0o700)
    }
    expect(outcome).toMatchObject({ ok: false, reason: 'journal-failed' })
    expect(createJournal(journalPath).read().map((e) => e.phase)).toEqual(['intent'])
    expect((await conductor.reconcile()).needsAttention).toBe(true)
    expect(conductor.lockHolder()).toBeNull()
  })

  it('refuses when there is no operation at all to acknowledge', async () => {
    const { conductor } = build()
    await expect(conductor.acknowledgeOperation('op-crash', 'reviewed'))
      .resolves.toMatchObject({ ok: false, reason: 'unknown-operation' })
  })

  // End to end through the shipped backend — the layer the panel actually
  // talks to — because that is where the gate is enforced.
  it('lets the very next publish through, after an acknowledge', async () => {
    const { lanes, conductor, lane } = await interruptedOperation()
    const backend = createShippedConductorBackend({
      lanes, conductor, settings,
      createSession: async () => ({ id: 'sess' }),
      closeSession: async () => undefined
    } as never)
    // Re-adopt the lane the crash left behind, the way a restart would.
    const adopted = await backend.createLane({ roleId: 'redo', agent: { presetId: 'shell', model: null } })
    commit(adopted.worktree, 'b.txt', 'two\n', 'redo lane work')
    expect(lane.id).not.toBe(adopted.id)

    await backend.reconcile()
    expect(await backend.publishLane(adopted.id)).toMatchObject({ ok: false, reason: 'needs-attention' })

    const outcome = await backend.acknowledgeOperation('op-crash', 'reviewed in the panel')
    expect(outcome).toMatchObject({ ok: true })
    expect((await backend.state()).needsAttention).toBe(false)

    const published = await backend.publishLane(adopted.id)
    expect(published).toMatchObject({ ok: true })
    if (published.ok) {
      expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(published.commit)
    }
  })
})

// ── Re-review "also fix": the test-recipe restart test that finding 3 asked
// for. The two tests shipped for it stopped at the store — they proved the
// recipe was WRITTEN, never that a rebuilt controller's publish actually
// runs it. That is the whole point of persisting it: before the fix, a
// restart reverted to `test: null` and every publish silently skipped the
// tests it was supposed to gate on, while the UI still showed the recipe.
// This drives the real controller, real store round trip, real git and the
// real (uninjected) test runner.
describe('a test recipe put in force survives a restart', () => {
  it('runs the test phase on a publish made by a controller rebuilt from the store', async () => {
    const configs: ConductorConfig[] = []
    const storedLanes: ConductorLane[] = []
    const deps = {
      userDataDir: root,
      getConductorConfigs: () => configs,
      saveConductorConfigs: (list: ConductorConfig[]) => {
        configs.splice(0, configs.length, ...list)
        return configs
      },
      getConductorLanes: () => storedLanes,
      saveConductorLanes: (list: ConductorLane[]) => {
        storedLanes.splice(0, storedLanes.length, ...list)
        return storedLanes
      },
      createSession: async () => ({ id: 'session-1' }),
      closeSession: async () => undefined,
      broadcast: () => undefined
    }

    // A recipe that fails deterministically: a publish that runs it is
    // refused and journals a 'tests' phase, while a publish that skipped it
    // would sail through — so "did the test phase run?" is answerable from
    // behaviour rather than from a spy.
    const recipe = { command: 'sh', args: ['-c', 'exit 3'], cwd: '.', timeoutMs: 10_000 }

    const first = createConductorController(deps)
    const composed = await first.compose('ws-1', {
      repo: settings.repo,
      integrationBranch: 'crew/integration',
      rows: [{ roleName: 'builder', kind: 'author' as const, agent: { presetId: 'shell', model: null } }],
      test: recipe
    })
    expect(composed.ok).toBe(true)
    expect(configs[0].test).toEqual(recipe)

    // The restart: a brand-new controller, sharing nothing with the first
    // but the store's contents.
    const restarted = createConductorController(deps)
    const backend = restarted.backendFor('ws-1')
    const state = await backend.state()
    expect(state.enabled).toBe(true)
    expect(state.lanes).toHaveLength(1)

    const lane = state.lanes[0]
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const before = git(['rev-parse', 'crew/integration'], settings.repo)

    await backend.reconcile()
    const outcome = await backend.publishLane(lane.id)

    // Load-bearing: with the recipe lost across the restart, this publish
    // succeeds and the ref moves.
    expect(outcome).toMatchObject({ ok: false, reason: 'tests-failed' })
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(before)
    const phases = createJournal(join(root, 'conductor', 'ws-1', 'journal.ndjson')).read().map((e) => e.phase)
    expect(phases).toContain('tests')
  })
})
