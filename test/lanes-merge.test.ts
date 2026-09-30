import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { createLaneManager, isOwnWorktree, notOwnWorktreeMessage } from '../src/main/lanes'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e'
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // stderr inherited: a real git failure in an ordinary call must still be
    // visible in test output.
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...ENV }
  }).trim()
}

// Used only at call sites where the git command is expected to fail as part
// of the assertion itself, so its stderr never reaches test output.
function gitExpectFailure(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ENV }
  })
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body)
  git(['add', '.'], cwd)
  git(['commit', '-m', message], cwd)
}

/** `git init` plus a committer identity recorded IN the repository.
 *
 *  The ENV above only reaches the commands this file runs itself. Every
 *  merge that produces a commit (a true merge, or the `--no-edit` attempt
 *  that ends in a conflict) is run by the PRODUCT, through supervise.ts,
 *  with the ambient environment — and a Windows CI runner has no global
 *  `user.email`, so git refused with "Committer identity unknown" long
 *  before any of these assertions could be reached. Linked worktrees share
 *  their repository's config, so recording it once here covers the lane and
 *  integration worktrees too. */
function initRepo(dir: string): void {
  execFileSync('git', ['init', '-b', 'main', dir])
  execFileSync('git', ['config', 'user.name', ENV.GIT_COMMITTER_NAME], { cwd: dir })
  execFileSync('git', ['config', 'user.email', ENV.GIT_COMMITTER_EMAIL], { cwd: dir })
}

/** Overwrites a worktree's `.git` FILE. Git for Windows creates it with the
 *  hidden attribute (`core.hideDotFiles=dotGitOnly`), and `writeFileSync`
 *  over a hidden file fails EPERM there, so the file has to be removed
 *  first. A no-op difference on macOS; the content written is identical. */
function writeGitFile(worktree: string, contents: string): void {
  rmSync(join(worktree, '.git'), { force: true })
  writeFileSync(join(worktree, '.git'), contents)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-merge-'))
  const repo = join(root, 'repo')
  initRepo(repo)
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

describe('mergeInIntegration', () => {
  it('fast-forwards when the base is an ancestor of the candidate', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const result = await lanes.mergeInIntegration(tip, base)

    expect(result).toMatchObject({ ok: true, fastForward: true })
    if (result.ok) expect(result.resultSha).toBe(tip)
  })

  it('creates a merge commit when both sides moved', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'a.txt', 'A\n', 'a work')
    commit(b.worktree, 'b.txt', 'B\n', 'b work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch as string], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch as string], settings.repo),
      first.resultSha
    )
    expect(second).toMatchObject({ ok: true, fastForward: false })
    if (second.ok) {
      const parents = git(['rev-list', '--parents', '-n', '1', second.resultSha], settings.repo).split(' ')
      expect(parents).toHaveLength(3)
    }
  })

  // The lock is never held across a conflict, so the merge must leave no
  // MERGE_HEAD behind for the next publication to trip over.
  it('aborts a conflicted merge, names the paths, and leaves no merge state', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    commit(a.worktree, 'shared.txt', 'from A\n', 'a work')
    commit(b.worktree, 'shared.txt', 'from B\n', 'b work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch as string], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch as string], settings.repo),
      first.resultSha
    )
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.conflictPaths).toContain('shared.txt')
    expect(existsSync(join(settings.integrationWorktree, '.git'))).toBe(true)
    const status = git(['status', '--porcelain'], settings.integrationWorktree)
    expect(status).toBe('')
  })

  it('keeps the integration worktree detached after merging', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    await lanes.mergeInIntegration(git(['rev-parse', lane.branch as string], settings.repo), base)
    expect(() => gitExpectFailure(['symbolic-ref', 'HEAD'], settings.integrationWorktree)).toThrow()
  })

  // A non-conflict git failure (here: an unresolvable revision) must never
  // be misreported as "the lane conflicts" — it has to propagate as a real
  // error so the caller does not treat it as something a human resolves by
  // editing files.
  it('propagates a genuine git failure instead of reporting a conflict', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    await expect(lanes.mergeInIntegration('not-a-real-revision', base)).rejects.toThrow(/git merge/)
  })

  // Wave 3, finding 3: the app can be killed in the brief window between a
  // conflicting `git merge` and the `--abort` that follows it, and git then
  // leaves MERGE_HEAD and an unmerged index behind. Conductor owns this
  // worktree outright, so nothing else can be waiting on that state — but
  // until this fix every later publication died on `checkout --detach` with
  // "you need to resolve your current index first", which is not a conflict
  // and not something the user could act on from the panel.
  it('recovers an integration worktree a crash left mid-merge, instead of wedging every later publish', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const one = await lanes.create('one', { presetId: 'shell', model: null })
    const two = await lanes.create('two', { presetId: 'shell', model: null })
    commit(one.worktree, 'README.md', 'one\n', 'one edits the readme')
    commit(two.worktree, 'README.md', 'two\n', 'two edits the readme')
    const oneTip = git(['rev-parse', one.branch as string], settings.repo)
    const twoTip = git(['rev-parse', two.branch as string], settings.repo)

    // Exactly the state the crash leaves: a conflicting merge started in the
    // integration worktree and never aborted.
    git(['checkout', '--detach', oneTip], settings.integrationWorktree)
    try {
      gitExpectFailure(['merge', '--no-edit', twoTip], settings.integrationWorktree)
    } catch {
      /* the conflict is the point */
    }
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toMatch(/^UU /m)
    expect(existsSync(join(settings.integrationWorktree, '.git'))).toBe(true)

    const result = await lanes.mergeInIntegration(oneTip, base)

    expect(result).toMatchObject({ ok: true })
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toBe('')
    expect(() => gitExpectFailure(['rev-parse', '--verify', 'MERGE_HEAD'], settings.integrationWorktree)).toThrow()
  })

  // Wave 4, B-1 (S2): the integration worktree is normally detached, but
  // nothing guarantees it — the user can check a branch out in it, and git
  // never stops them. `reset --hard <base>` moves whatever ref HEAD points
  // at, so the repair below used to rewind that branch to the operation's
  // base and throw away commits made on it, while the publication it was
  // clearing the way for still reported success. The repair must put the
  // WORKTREE back without ever moving a REF: `checkout --force --detach`.
  it('repairs a wedged integration worktree whose HEAD is on a branch without moving that branch', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const one = await lanes.create('one', { presetId: 'shell', model: null })
    const two = await lanes.create('two', { presetId: 'shell', model: null })
    commit(one.worktree, 'README.md', 'one\n', 'one edits the readme')
    commit(two.worktree, 'README.md', 'two\n', 'two edits the readme')
    const oneTip = git(['rev-parse', one.branch as string], settings.repo)
    const twoTip = git(['rev-parse', two.branch as string], settings.repo)

    // The user checked a branch out in the integration worktree and
    // committed on it. Nothing in Conductor put it there, and nothing in
    // Conductor may take it away.
    git(['checkout', '-b', 'feature', oneTip], settings.integrationWorktree)
    commit(settings.integrationWorktree, 'notes.txt', 'mine\n', 'work the user did on feature')
    const feature = git(['rev-parse', 'feature'], settings.repo)
    expect(feature).not.toBe(base)

    // …and then the crash window: a conflicting merge started and never
    // aborted, which is what makes the repair run at all.
    try {
      gitExpectFailure(['merge', '--no-edit', twoTip], settings.integrationWorktree)
    } catch {
      /* the conflict is the point */
    }
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toMatch(/^UU /m)

    const result = await lanes.mergeInIntegration(oneTip, base)

    expect(result).toMatchObject({ ok: true })
    // Load-bearing: the branch the user had checked out still points where
    // they left it. With `reset --hard <base>` here, `feature` is rewound to
    // `base` and the commit above survives only in the reflog.
    expect(git(['rev-parse', 'feature'], settings.repo)).toBe(feature)
    // …and the worktree really was repaired: detached, clean, no MERGE_HEAD.
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toBe('')
    expect(() => gitExpectFailure(['symbolic-ref', '-q', 'HEAD'], settings.integrationWorktree)).toThrow()
  })

  // Wave 4, B-2 (S3): if the integration folder loses its `.git` file and
  // happens to sit inside another repository, every git command Conductor
  // runs there lands in THAT repository instead. `merge --abort` in a repo
  // the user is mid-conflict in destroys their half-resolved merge. Prove
  // the folder is its own worktree before touching git at all.
  it('refuses to repair when the integration folder is not its own worktree, rather than running git in the enclosing repo', async () => {
    const outer = join(root, 'outer')
    execFileSync('git', ['init', '-b', 'main', outer])
    commit(outer, 'shared.txt', 'base\n', 'outer base')
    git(['checkout', '-b', 'side'], outer)
    commit(outer, 'shared.txt', 'side\n', 'outer side')
    git(['checkout', 'main'], outer)
    commit(outer, 'shared.txt', 'main\n', 'outer main')
    try {
      gitExpectFailure(['merge', '--no-edit', 'side'], outer)
    } catch {
      /* the user's own conflict, mid-resolution */
    }
    writeFileSync(join(outer, 'shared.txt'), 'half resolved by hand\n')
    const outerMergeHead = git(['rev-parse', 'MERGE_HEAD'], outer)

    settings.integrationWorktree = join(outer, 'integration')
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)

    // The worktree loses its link to the repo; the folder is now just a
    // directory inside `outer`'s working tree.
    rmSync(join(settings.integrationWorktree, '.git'), { force: true })

    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)

    // Load-bearing: the user's own conflicted merge, in their own repo, is
    // exactly as they left it.
    expect(git(['rev-parse', 'MERGE_HEAD'], outer)).toBe(outerMergeHead)
    expect(readFileSync(join(outer, 'shared.txt'), 'utf8')).toBe('half resolved by hand\n')
  })

  // Wave 4, F-2 (M3): the repair deletes untracked strays as well as
  // resetting tracked files. Without `clean -fd` a stray left by a killed
  // test run stays in the worktree and can change what the next
  // publication's tests see.
  it('deletes untracked strays from the integration worktree as part of the repair', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const one = await lanes.create('one', { presetId: 'shell', model: null })
    const two = await lanes.create('two', { presetId: 'shell', model: null })
    commit(one.worktree, 'README.md', 'one\n', 'one edits the readme')
    commit(two.worktree, 'README.md', 'two\n', 'two edits the readme')
    const oneTip = git(['rev-parse', one.branch as string], settings.repo)
    const twoTip = git(['rev-parse', two.branch as string], settings.repo)

    git(['checkout', '--detach', oneTip], settings.integrationWorktree)
    try {
      gitExpectFailure(['merge', '--no-edit', twoTip], settings.integrationWorktree)
    } catch {
      /* the conflict is the point */
    }
    writeFileSync(join(settings.integrationWorktree, 'stray.txt'), 'left by a killed test run\n')

    const result = await lanes.mergeInIntegration(oneTip, base)

    expect(result).toMatchObject({ ok: true })
    expect(existsSync(join(settings.integrationWorktree, 'stray.txt'))).toBe(false)
    expect(git(['status', '--porcelain'], settings.integrationWorktree)).toBe('')
  })
}, { timeout: 30_000 })

describe('syncLane', () => {
  // Without a way back, a lane edits stale code indefinitely and semantic
  // conflicts become the normal case rather than the exception.
  it('brings the integration branch into the lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    // Land something on integration that the lane has never seen.
    const other = await lanes.create('other', { presetId: 'shell', model: null })
    commit(other.worktree, 'other.txt', 'O\n', 'other work')
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const merged = await lanes.mergeInIntegration(
      git(['rev-parse', other.branch as string], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    git(['update-ref', 'refs/heads/crew/integration', merged.resultSha], settings.repo)

    expect(existsSync(join(lane.worktree, 'other.txt'))).toBe(false)
    const result = await lanes.syncLane(lane, merged.resultSha)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(lane.worktree, 'other.txt'), 'utf8')).toBe('O\n')
    expect((await lanes.facts(lane)).behind).toBe(0)
  })

  it('aborts and reports paths when a sync conflicts', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const other = await lanes.create('other', { presetId: 'shell', model: null })
    commit(lane.worktree, 'shared.txt', 'lane\n', 'lane work')
    commit(other.worktree, 'shared.txt', 'other\n', 'other work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const merged = await lanes.mergeInIntegration(
      git(['rev-parse', other.branch as string], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    git(['update-ref', 'refs/heads/crew/integration', merged.resultSha], settings.repo)

    const result = await lanes.syncLane(lane, merged.resultSha)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflictPaths).toContain('shared.txt')
    expect(git(['status', '--porcelain'], lane.worktree)).toBe('')
  })

  // A linked worktree's .git is a file pointing at repo/.git/worktrees/<name>,
  // not a directory of its own; `merge --abort` needs to write there
  // (MERGE_HEAD, the index lock, ORIG_HEAD). Making that admin directory
  // read-only forces the abort itself to fail, deterministically, without
  // mocking anything: it's the same technique test/installer.test.ts uses to
  // force a real write failure via chmodSync.
  //
  // Windows-only skip: the simulation, not the code, is what fails to port.
  // It revokes the write bit on a DIRECTORY, and Node's chmod on Windows
  // maps only FILE_ATTRIBUTE_READONLY, which the filesystem ignores for
  // directories entirely — so the chmod is a no-op, `merge --abort`
  // succeeds, and the "failed abort" this test exists to describe never
  // occurs. lanes.ts exposes no seam to inject the failure through (the
  // abort is a runGit call inside mergeAt), and the only Windows mechanism
  // that would work is a DACL change via icacls, which an elevated CI
  // account bypasses. The behaviour stays fully covered on macOS/Linux.
  it.skipIf(process.platform === 'win32')('reports both the original conflict and a failed abort, and leaves the worktree usable once permissions are restored', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const other = await lanes.create('other', { presetId: 'shell', model: null })
    commit(lane.worktree, 'shared.txt', 'lane\n', 'lane work')
    commit(other.worktree, 'shared.txt', 'other\n', 'other work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const merged = await lanes.mergeInIntegration(
      git(['rev-parse', other.branch as string], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    // Pre-create the real conflict with raw git, while the worktree's git
    // dir is still writable: this leaves MERGE_HEAD and an unmerged
    // shared.txt in place, exactly as a genuinely conflicted merge would.
    expect(() => gitExpectFailure(['merge', '--no-edit', merged.resultSha], lane.worktree)).toThrow()

    const gitDirOut = git(['rev-parse', '--git-dir'], lane.worktree)
    const gitDir = isAbsolute(gitDirOut) ? gitDirOut : resolve(lane.worktree, gitDirOut)
    expect(gitDir).toContain(join('.git', 'worktrees'))

    chmodSync(gitDir, 0o500)
    let caught: unknown
    try {
      // syncLane's own merge attempt now runs against the already-conflicted
      // worktree: git refuses ("you have not concluded your merge"), the
      // pre-existing unmerged paths are still there, and the abort it then
      // tries fails because it cannot write into the read-only git dir.
      await lanes.syncLane(lane, merged.resultSha)
    } catch (err) {
      caught = err
    } finally {
      // Must run even if an assertion above throws, or the temp dir left by
      // afterEach's rmSync becomes unremovable.
      chmodSync(gitDir, 0o700)
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/manual attention/)
    expect(message).toMatch(/shared\.txt/)
    expect(message).toMatch(/merge --abort/)
    expect(message).toMatch(/merging is not possible/i)

    // Permissions restored: the worktree can now actually be untangled.
    git(['merge', '--abort'], lane.worktree)
    expect(git(['status', '--porcelain'], lane.worktree)).toBe('')
  })

  // A reviewer lane is detached at a candidate SHA and owns no branch;
  // syncing it in place would strand commits nothing ever tracks.
  it('rejects syncing a branchless (reviewer) lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const authored = await lanes.create('builder', { presetId: 'shell', model: null })
    const reviewerLane = { ...authored, kind: 'reviewer' as const, branch: null }
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    await expect(lanes.syncLane(reviewerLane, base)).rejects.toThrow(/builder/)
    await expect(lanes.syncLane(reviewerLane, base)).rejects.toThrow(/branch/i)
  })
}, { timeout: 30_000 })

// Wave 5, B-3/B-4/F-7/F-8. Every scenario here drives real git against real
// repositories and asserts on what survives in the USER's repository, never
// on a mock. GIT_CEILING_DIRECTORIES is set to the scenario root throughout:
// if a guard ever fails and git walks upwards looking for a repository, it
// stops at the root of the temp directory instead of finding whatever repo
// the test runner itself happens to be inside.
describe('the ownership guard', () => {
  let previousCeiling: string | undefined

  beforeEach(() => {
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(root)
  })

  afterEach(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling
  })

  /** A repository of the user's own, left half-way through resolving a
   *  conflict by hand: MERGE_HEAD present, the conflicted file edited but
   *  not staged. Everything Conductor must not destroy, in one place. */
  function userRepoMidMerge(name: string): { dir: string; mergeHead: string; head: string } {
    const dir = join(root, name)
    initRepo(dir)
    commit(dir, 'shared.txt', 'base\n', 'outer base')
    git(['checkout', '-b', 'side'], dir)
    commit(dir, 'shared.txt', 'side\n', 'outer side')
    git(['checkout', 'main'], dir)
    commit(dir, 'shared.txt', 'main\n', 'outer main')
    try {
      gitExpectFailure(['merge', '--no-edit', 'side'], dir)
    } catch {
      /* the user's own conflict, mid-resolution */
    }
    writeFileSync(join(dir, 'shared.txt'), 'half resolved by hand\n')
    return {
      dir,
      mergeHead: git(['rev-parse', 'MERGE_HEAD'], dir),
      head: git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    }
  }

  // B-3: mergeInIntegration proved ownership (wave 4) but syncLane did not,
  // so a lane that lost its `.git` file inside the user's repository made
  // `merge --abort` run THERE — reverting the user's hand-resolved file and
  // throwing away their MERGE_HEAD, then reporting the outer repository's
  // file as the lane's conflict.
  it('refuses to sync a lane that is not its own worktree, instead of aborting the merge in the enclosing repo', async () => {
    const outer = userRepoMidMerge('outer')
    settings.lanesDir = join(outer.dir, 'lanes')
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    // The lane folder loses its link to the repo; it is now just a directory
    // inside the user's working tree, and git resolves upwards to the user's
    // repository from it.
    rmSync(join(lane.worktree, '.git'), { force: true })

    await expect(lanes.syncLane(lane, base)).rejects.toThrow(/lane worktree/i)

    // Load-bearing: the user's half-resolved merge is exactly as they left it.
    expect(git(['rev-parse', 'MERGE_HEAD'], outer.dir)).toBe(outer.mergeHead)
    expect(readFileSync(join(outer.dir, 'shared.txt'), 'utf8')).toBe('half resolved by hand\n')
  })

  // B-4/A1: a `.git` FILE is enough to make `rev-parse --show-toplevel`
  // report the folder it sits in, so the wave-4 check accepted a pointer
  // aimed straight at the user's own repository — and every command then ran
  // against the user's index, HEAD and MERGE_HEAD while reporting success.
  it('rejects a .git file that points at the user’s own repository', async () => {
    const outer = userRepoMidMerge('outer')
    const staged = join(outer.dir, 'staged.txt')
    writeFileSync(staged, 'work the user staged\n')
    git(['add', 'staged.txt'], outer.dir)

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    writeGitFile(settings.integrationWorktree, `gitdir: ${join(outer.dir, '.git')}\n`)

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(false)
    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)

    // Load-bearing: merge state, staged work and the user's branch all
    // survive. On the pre-fix code MERGE_HEAD was gone, the index was reset
    // and HEAD was detached.
    expect(git(['rev-parse', 'MERGE_HEAD'], outer.dir)).toBe(outer.mergeHead)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], outer.dir)).toBe(outer.head)
    expect(git(['diff', '--cached', '--name-only'], outer.dir)).toContain('staged.txt')
  })

  // B-4/A1b: the same, aimed at one of the user's LINKED worktrees. Its
  // administrative directory does have a `gitdir` file — but that file names
  // the user's folder, not ours, which is exactly what the back-pointer
  // check asks.
  it('rejects a .git file that points at one of the user’s linked worktrees', async () => {
    const outer = userRepoMidMerge('outer')
    const userWorktree = join(root, 'user-worktree')
    git(['worktree', 'add', '--detach', userWorktree], outer.dir)
    writeFileSync(join(userWorktree, 'scratch.txt'), 'work in the user’s worktree\n')
    git(['add', 'scratch.txt'], userWorktree)
    const userHead = git(['rev-parse', 'HEAD'], userWorktree)

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const administrative = readFileSync(join(userWorktree, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '')
    writeGitFile(settings.integrationWorktree, `gitdir: ${administrative}\n`)

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(false)
    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)

    expect(git(['rev-parse', 'HEAD'], userWorktree)).toBe(userHead)
    expect(git(['diff', '--cached', '--name-only'], userWorktree)).toContain('scratch.txt')
    expect(readFileSync(join(userWorktree, 'scratch.txt'), 'utf8')).toBe('work in the user’s worktree\n')
  })

  /** One of the user's own linked worktrees of the very repository
   *  Conductor is conducting, with a staged file, an unstaged edit to a
   *  tracked file and an untracked file — the three kinds of work a forced
   *  checkout plus `clean -fd` destroys. */
  function userWorktreeWithWork(name: string): {
    dir: string
    head: string
    branch: string
  } {
    commit(settings.repo, 'tracked.txt', 'committed\n', 'user tracked')
    const dir = join(root, name)
    git(['worktree', 'add', '-b', 'users-work', dir], settings.repo)
    writeFileSync(join(dir, 'staged.txt'), 'work the user staged\n')
    git(['add', 'staged.txt'], dir)
    writeFileSync(join(dir, 'tracked.txt'), 'edited but not staged\n')
    writeFileSync(join(dir, 'untracked.txt'), 'never committed anywhere\n')
    return {
      dir,
      head: git(['rev-parse', 'HEAD'], dir),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    }
  }

  /** Everything the guard exists to protect, asserted in one place. */
  function expectUserWorkIntact(user: { dir: string; head: string; branch: string }): void {
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], user.dir)).toBe(user.branch)
    expect(git(['rev-parse', 'HEAD'], user.dir)).toBe(user.head)
    expect(git(['diff', '--cached', '--name-only'], user.dir)).toContain('staged.txt')
    expect(readFileSync(join(user.dir, 'tracked.txt'), 'utf8')).toBe('edited but not staged\n')
    expect(existsSync(join(user.dir, 'untracked.txt'))).toBe(true)
  }

  // Wave 6, B-5 (A8): `realOrSelf` resolved the symlink on BOTH sides of
  // every comparison, so a symlink standing where the integration worktree
  // should be made the guard compare the user's worktree with itself — and
  // a real worktree of theirs has a perfectly correct back-pointer, so both
  // halves of the check said yes. Publish then returned `ok: true` while
  // the forced checkout detached the user's HEAD, the merge overwrote their
  // index and `clean -fd` deleted their untracked file. A symlink is never
  // something Conductor created, so the path itself is refused before any
  // realpath call can resolve the deception away.
  it('refuses an integration path that is a symlink to one of the user’s worktrees', async () => {
    const user = userWorktreeWithWork('userwt')

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    rmSync(settings.integrationWorktree, { recursive: true, force: true })
    symlinkSync(user.dir, settings.integrationWorktree)

    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)
    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(false)
    expectUserWorkIntact(user)
  })

  // The same deception aimed at a LANE, which reaches the guard through
  // `syncLane` rather than through the publication path.
  it('refuses a lane path that is a symlink to one of the user’s worktrees', async () => {
    const user = userWorktreeWithWork('userwt')

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    rmSync(lane.worktree, { recursive: true, force: true })
    symlinkSync(user.dir, lane.worktree)

    expect(await isOwnWorktree(lane.worktree, 'lane worktree')).toBe(false)
    await expect(lanes.syncLane(lane, base)).rejects.toThrow(/lane worktree/i)
    expectUserWorkIntact(user)
  })

  // Wave 6, B-5 (A8p): the leaf need not be the symlink. When the folder
  // CONTAINING the integration worktree is a symlink to a directory that
  // happens to hold a worktree of the user's called `integration`, every
  // path Conductor derives lands in the user's tree — so the parent is
  // checked too.
  it('refuses when the folder containing the integration worktree is a symlink', async () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const planted = join(elsewhere, 'integration')
    git(['worktree', 'add', '-b', 'users-work', planted], settings.repo)
    writeFileSync(join(planted, 'staged.txt'), 'work the user staged\n')
    git(['add', 'staged.txt'], planted)
    const head = git(['rev-parse', 'HEAD'], planted)

    const workspace = join(root, 'workspace')
    symlinkSync(elsewhere, workspace)
    settings.integrationWorktree = join(workspace, 'integration')

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(false)
    const lanes = createLaneManager(settings)
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], planted)).toBe('users-work')
    expect(git(['rev-parse', 'HEAD'], planted)).toBe(head)
    expect(git(['diff', '--cached', '--name-only'], planted)).toContain('staged.txt')
  })

  // Wave 6, B-6 (A12): with `worktree.useRelativePaths` (git ≥ 2.48) git
  // writes the back-pointer as a path relative to the administrative
  // directory that holds it. Resolving it against `process.cwd()` made it
  // name a directory that does not exist, so the guard said no to
  // Conductor's OWN worktrees and every publish and sync in the workspace
  // failed — a false reject is every bit as much a defect as a false
  // accept.
  it('accepts its own worktrees when git writes relative back-pointers', async () => {
    git(['config', 'worktree.useRelativePaths', 'true'], settings.repo)

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    // The scenario is only meaningful if git really did write a relative
    // back-pointer; on a git without the option it would be absolute.
    const administrative = readFileSync(join(settings.integrationWorktree, '.git'), 'utf8')
      .trim()
      .replace(/^gitdir:\s*/, '')
    expect(isAbsolute(administrative)).toBe(false)

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(true)
    expect(await isOwnWorktree(lane.worktree, 'lane worktree')).toBe(true)

    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    expect(await lanes.mergeInIntegration(tip, base)).toMatchObject({ ok: true })
  })

  // The guard must still say yes to the folder Conductor actually owns —
  // it runs on every publish, so a false reject is not "safe", it is a
  // dead workspace.
  it('accepts the worktree Conductor created', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(true)
    expect(await isOwnWorktree(lane.worktree, 'lane worktree')).toBe(true)
    // The user's repository itself is never one of ours.
    expect(await isOwnWorktree(settings.repo)).toBe(false)
  })

  // F-7 (A4): on a case-insensitive volume a settings path spelled with
  // different letter case names the SAME directory, and `realpathSync`
  // (non-native) leaves that spelling alone — so the comparison failed and
  // every publish returned an error. `realpathSync.native` reports the
  // volume's own casing for both sides. Skipped where the volume really is
  // case-sensitive, because there the two paths are genuinely different
  // directories and rejecting is correct.
  //
  // Wave 6, F-13: this test used to `return` early on a case-sensitive
  // volume, so on such a volume it asserted NOTHING while still reporting
  // green. Both volumes are now asserted: insensitive → the variant is the
  // same worktree and is accepted; sensitive → it is a different path
  // altogether and refusing it is the right answer. Which volume this is
  // is decided by a probe, and stated, so the branch taken is never a
  // silent one.
  it('accepts a path whose letter case differs on a case-insensitive volume, and refuses it on a case-sensitive one', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()

    // The probe: a file created in one spelling, looked for in another.
    const probe = join(root, 'case-probe')
    writeFileSync(probe, 'probe\n')
    const caseInsensitive = existsSync(join(root, 'CASE-PROBE'))

    const variant = join(root, 'INTEGRATION')
    expect(existsSync(join(variant, '.git'))).toBe(caseInsensitive)
    expect(await isOwnWorktree(variant)).toBe(caseInsensitive)
    if (caseInsensitive) {
      // The point of realpathSync.native: the volume's own spelling, for
      // both sides, so the comparison is between directories and not
      // between the letters somebody happened to type.
      expect(realpathSync.native(variant)).toBe(realpathSync.native(settings.integrationWorktree))
    } else {
      expect(notOwnWorktreeMessage(variant)).toMatch(/does not exist/i)
    }
  })

  // F-8 (A5): git keeps listing a deleted worktree as "prunable", so
  // ensureIntegrationWorktree's "is it already registered?" answered yes for
  // a folder that was not there and returned without creating it. Nothing
  // Conductor could do recovered from that — only a manual `git worktree
  // prune`.
  it('re-creates an integration folder that was deleted but is still registered', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    rmSync(settings.integrationWorktree, { recursive: true, force: true })
    expect(git(['worktree', 'list', '--porcelain'], settings.repo)).toContain('prunable')

    const result = await lanes.mergeInIntegration(tip, base)

    expect(result).toMatchObject({ ok: true })
    expect(existsSync(join(settings.integrationWorktree, '.git'))).toBe(true)
    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(true)
  })

  // …and when a folder genuinely is not there, the refusal must say so
  // rather than blaming a "mid-merge enclosing repository" the user would
  // then go looking for.
  it('says a missing folder is missing, not that it resolves to an enclosing repository', () => {
    const message = notOwnWorktreeMessage(join(root, 'nowhere'))
    expect(message).toMatch(/does not exist/i)
    expect(message).not.toMatch(/enclosing repository/i)
  })

  // Wave 6, F-8 (A15): a folder that is present but has lost its `.git`
  // was told it "resolves to some enclosing repository" even when no
  // enclosing repository exists, and was given no way out — every later
  // publish failed identically. Conductor still refuses to touch it (it may
  // be full of somebody's work), but now says what it is and how to clear
  // it.
  it('says a folder with no .git is not a Conductor worktree, and how to recover it', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    rmSync(join(settings.integrationWorktree, '.git'), { force: true })
    writeFileSync(join(settings.integrationWorktree, 'someones-work.txt'), 'not ours\n')

    const message = notOwnWorktreeMessage(settings.integrationWorktree)
    expect(message).toMatch(/not a Conductor worktree/i)
    expect(message).toMatch(/no \.git entry/i)
    expect(message).toMatch(/delete it/i)
    expect(message).toMatch(/git worktree repair/i)
    expect(message).not.toMatch(/enclosing repository/i)
    expect(message).not.toMatch(/does not exist/i)

    // …and it is still a refusal: the folder and its contents survive.
    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/not a Conductor worktree/i)
    expect(existsSync(join(settings.integrationWorktree, 'someones-work.txt'))).toBe(true)
  })

  // Wave 6, F-14: `git worktree lock` outlives the folder, and a single
  // `--force` is refused outright for "a missing but locked worktree" —
  // git's own error names `add -f -f`. One force left the workspace with no
  // way forward from the panel.
  it('re-creates an integration folder that was deleted while its registration was locked', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    git(['worktree', 'lock', settings.integrationWorktree], settings.repo)
    rmSync(settings.integrationWorktree, { recursive: true, force: true })

    const result = await lanes.mergeInIntegration(tip, base)

    expect(result).toMatchObject({ ok: true })
    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(true)
  })

  // Wave 6, F-12 (A8b): `lane.worktree` arrives from the saved store, which
  // is an ordinary JSON file. Pointed at one of the user's worktrees it made
  // syncLane fast-forward the user's branch; the path must be proved to sit
  // inside Conductor's own lanes folder first.
  it('refuses to sync a lane whose recorded worktree is outside the lanes folder', async () => {
    const user = userWorktreeWithWork('userwt')

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const tampered = { ...lane, worktree: user.dir }
    await expect(lanes.syncLane(tampered, base)).rejects.toThrow(/lanes folder/i)
    expectUserWorkIntact(user)
  })

  // A sibling of the lanes folder is not inside it, however similar the
  // spelling — which is exactly why containment is proved with
  // `path.relative` and never with `startsWith`.
  it('refuses a recorded worktree in a sibling folder whose name merely starts with the lanes folder’s', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const sibling = `${settings.lanesDir}-evil`
    git(['worktree', 'add', '-b', 'somewhere-else', sibling], settings.repo)
    const tampered = { ...lane, worktree: join(sibling) }

    await expect(lanes.syncLane(tampered, base)).rejects.toThrow(/lanes folder/i)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], sibling)).toBe('somewhere-else')
  })

  // Containment alone is not enough: `git worktree add` run from ANY
  // repository can plant a worktree inside Crew's own folder, and
  // `destroy({ force: true })` deletes whatever folder it is handed.
  it('refuses to destroy a lane folder that belongs to another repository', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    const other = join(root, 'other-repo')
    execFileSync('git', ['init', '-b', 'main', other])
    commit(other, 'theirs.txt', 'theirs\n', 'their base')
    const planted = join(settings.lanesDir, 'planted')
    git(['worktree', 'add', '-b', 'theirs', planted], other)
    writeFileSync(join(planted, 'precious.txt'), 'never committed anywhere\n')

    const tampered = { ...lane, worktree: planted }
    await expect(lanes.destroy(tampered, { force: true })).rejects.toThrow(/another repository/i)
    expect(existsSync(join(planted, 'precious.txt'))).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], planted)).toBe('theirs')
  })

  // Wave 6, F-13: `destroy` on a genuine lane still works — the guard above
  // must not have turned the ordinary path into a refusal.
  it('still destroys a genuine lane, folder and branch', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    await lanes.destroy(lane, { force: false })

    expect(existsSync(lane.worktree)).toBe(false)
    expect(() => gitExpectFailure(['rev-parse', '--verify', lane.branch as string], settings.repo)).toThrow()
  })

  // Wave 6, F-12 (A9): `merge` writes wherever HEAD points. An agent that
  // checks one of the user's branches out in its own lane worktree would
  // otherwise have Conductor fast-forward that branch into the integration
  // base — a write to a ref the user owns.
  it('refuses to sync a lane whose HEAD has been moved onto one of the user’s branches', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(settings.repo, 'theirs.txt', 'theirs\n', 'user work')
    git(['branch', 'users-feature'], settings.repo)
    const before = git(['rev-parse', 'users-feature'], settings.repo)
    commit(join(root, 'integration'), 'b.txt', 'two\n', 'integration work')
    git(['update-ref', 'refs/heads/crew/integration', 'HEAD'], join(root, 'integration'))
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    git(['checkout', 'users-feature'], lane.worktree)

    await expect(lanes.syncLane(lane, base)).rejects.toThrow(/users-feature/)
    expect(git(['rev-parse', 'users-feature'], settings.repo)).toBe(before)
  })

  // …and a lane detached at a SHA is refused for the same reason: a merge
  // there lands on no branch at all.
  it('refuses to sync a lane whose HEAD is detached', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    git(['checkout', '--detach'], lane.worktree)

    await expect(lanes.syncLane(lane, base)).rejects.toThrow(/detached HEAD/i)
  })

  // Wave 6, F-12 (A11): git takes its repository location from the
  // environment, and those variables OVERRIDE the cwd Conductor chose. A
  // GIT_INDEX_FILE inherited from whatever launched Crew pointed the
  // conductor's own merge at the user's index — and the merge still
  // reported success, because git did exactly what it was told.
  it('ignores an inherited GIT_INDEX_FILE aimed at the user’s index', async () => {
    const user = userWorktreeWithWork('userwt')
    const userIndex = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], user.dir)
    expect(existsSync(userIndex)).toBe(true)

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const previous = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = userIndex
    let result: Awaited<ReturnType<typeof lanes.mergeInIntegration>>
    try {
      result = await lanes.mergeInIntegration(tip, base)
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = previous
    }

    expect(result).toMatchObject({ ok: true })
    expectUserWorkIntact(user)
  })
}, { timeout: 30_000 })

// Wave 7, B-7. Conductor does not let anybody type a path: it DERIVES
// `<userData>/conductor/<workspaceId>/integration` and
// `<userData>/conductor/<workspaceId>/lanes/<lane>` (conductorPaths, in
// conductor-runtime.ts). Every scenario here therefore uses that real
// layout rather than the flat one above, because the whole finding is about
// which levels of it Conductor owns. The guard used to lstat the leaf and
// its parent only, calling everything above "the platform's" — so a symlink
// at `conductor` or at `<workspaceId>`, which needs filesystem access and
// nothing else, aimed every derived path at somewhere of the attacker's
// choosing and both halves of the guard said yes.
describe('the ownership guard on Conductor’s derived ancestors', () => {
  let previousCeiling: string | undefined
  let userData: string
  const workspaceId = 'ws-1'

  beforeEach(() => {
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(root)
    userData = join(root, 'userData')
    mkdirSync(join(userData, 'conductor', workspaceId), { recursive: true })
    settings.integrationWorktree = join(userData, 'conductor', workspaceId, 'integration')
    settings.lanesDir = join(userData, 'conductor', workspaceId, 'lanes')
  })

  afterEach(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling
  })

  interface UserWork {
    dir: string
    head: string
    branch: string
  }

  /** One of the user's own linked worktrees of the very repository
   *  Conductor is conducting, holding the three kinds of work a forced
   *  checkout plus `clean -fd` destroys: staged, unstaged, untracked. */
  function userWorktreeAt(dir: string, branch: string): UserWork {
    commit(settings.repo, 'tracked.txt', 'committed\n', 'user tracked')
    git(['worktree', 'add', '-b', branch, dir], settings.repo)
    writeFileSync(join(dir, 'staged.txt'), 'work the user staged\n')
    git(['add', 'staged.txt'], dir)
    writeFileSync(join(dir, 'tracked.txt'), 'edited but not staged\n')
    writeFileSync(join(dir, 'untracked.txt'), 'never committed anywhere\n')
    return {
      dir,
      head: git(['rev-parse', 'HEAD'], dir),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)
    }
  }

  function expectUserWorkIntact(user: UserWork): void {
    expect(existsSync(user.dir)).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], user.dir)).toBe(user.branch)
    expect(git(['rev-parse', 'HEAD'], user.dir)).toBe(user.head)
    expect(git(['diff', '--cached', '--name-only'], user.dir)).toContain('staged.txt')
    expect(readFileSync(join(user.dir, 'tracked.txt'), 'utf8')).toBe('edited but not staged\n')
    expect(existsSync(join(user.dir, 'untracked.txt'))).toBe(true)
  }

  // N1, bar (c): reports success while destroying work. `conductor` is a
  // symlink to a folder where `<workspaceId>/integration` is one of the
  // USER's worktrees of the same repository — so the back-pointer check
  // passes (it really IS a git-created worktree, just not ours) and, before
  // the fix, publish returned ok with a commit while the user's HEAD was
  // detached, their index overwritten and their untracked file deleted.
  it('refuses to publish when the conductor folder is a symlink over one of the user’s worktrees', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const elsewhere = join(root, 'elsewhere')
    mkdirSync(join(elsewhere, workspaceId), { recursive: true })
    const user = userWorktreeAt(join(elsewhere, workspaceId, 'integration'), 'users-work')

    rmSync(join(userData, 'conductor'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(userData, 'conductor'))

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(false)
    await expect(lanes.mergeInIntegration(tip, base)).rejects.toThrow(/integration worktree/i)
    expectUserWorkIntact(user)
  })

  // N2: the workspace folder is the symlink instead, and the lane path
  // lands on the user's own worktree. `destroy({ force: true })` deleted
  // the folder outright before throwing at `branch -d`.
  it('refuses to sync or destroy a lane when the workspace folder is a symlink over a user worktree', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    const workspace = join(userData, 'conductor', workspaceId)
    rmSync(workspace, { recursive: true, force: true })
    git(['worktree', 'prune'], settings.repo)

    const elsewhere = join(root, 'elsewhere')
    mkdirSync(join(elsewhere, 'lanes'), { recursive: true })
    const user = userWorktreeAt(join(elsewhere, 'lanes', 'builder'), 'users-work')
    symlinkSync(elsewhere, workspace)

    expect(await isOwnWorktree(lane.worktree, 'lane worktree')).toBe(false)
    await expect(lanes.syncLane(lane, base)).rejects.toThrow(/lane worktree/i)
    await expect(lanes.destroy(lane, { force: true })).rejects.toThrow(/lane worktree/i)
    expectUserWorkIntact(user)
  })

  // N2b: the same, with the user's worktree checked out on the lane's own
  // branch — so the `branch -d` that used to throw after the deletion
  // succeeded instead, and `destroy` returned SUCCESS having destroyed the
  // user's folder and its untracked file.
  it('refuses to destroy through a symlinked workspace even when the user’s worktree is on the lane branch', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    const workspace = join(userData, 'conductor', workspaceId)
    rmSync(workspace, { recursive: true, force: true })
    git(['worktree', 'prune'], settings.repo)

    const elsewhere = join(root, 'elsewhere')
    mkdirSync(join(elsewhere, 'lanes'), { recursive: true })
    const planted = join(elsewhere, 'lanes', 'builder')
    git(['worktree', 'add', planted, lane.branch as string], settings.repo)
    writeFileSync(join(planted, 'precious.txt'), 'never committed anywhere\n')
    symlinkSync(elsewhere, workspace)

    await expect(lanes.destroy(lane, { force: true })).rejects.toThrow(/lane worktree/i)
    expect(existsSync(planted)).toBe(true)
    expect(readFileSync(join(planted, 'precious.txt'), 'utf8')).toBe('never committed anywhere\n')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], planted)).toBe(lane.branch)
  })

  // The false-reject half, and the reason the walk stops where it does:
  // `<userData>` is the PLATFORM's, and a symlinked userData is an ordinary
  // configuration (it is also what `/var` -> `/private/var` looks like on
  // macOS). Checking one level too many would refuse every publish in such
  // a profile, which is every bit as much a blocker as accepting an attack.
  it('still publishes and syncs when userData itself — the level above conductor — is a symlink', async () => {
    const realUserData = join(root, 'real-userdata')
    mkdirSync(realUserData)
    rmSync(userData, { recursive: true, force: true })
    symlinkSync(realUserData, userData)
    mkdirSync(join(userData, 'conductor', workspaceId), { recursive: true })

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')
    const tip = git(['rev-parse', lane.branch as string], settings.repo)
    const base = git(['rev-parse', 'crew/integration'], settings.repo)

    expect(await isOwnWorktree(settings.integrationWorktree)).toBe(true)
    expect(await isOwnWorktree(lane.worktree, 'lane worktree')).toBe(true)

    const merged = await lanes.mergeInIntegration(tip, base)
    expect(merged).toMatchObject({ ok: true })
    if (!merged.ok) return
    expect(await lanes.syncLane(lane, merged.resultSha)).toMatchObject({ ok: true })
    await lanes.destroy(lane, { force: true })
    expect(existsSync(lane.worktree)).toBe(false)
  })
}, { timeout: 30_000 })

// Wave 7, F-15: Conductor's own plumbing runs in the user's repository, so
// the user's hooks fire for it. Every one of these fails CLOSED, so nothing
// is destroyed — but Conductor is unusable on any repository that uses
// hooks, which is most of them.
describe('the repository’s hooks and Conductor’s own plumbing', () => {
  let previousCeiling: string | undefined

  beforeEach(() => {
    previousCeiling = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(root)
  })

  afterEach(() => {
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES
    else process.env.GIT_CEILING_DIRECTORIES = previousCeiling
  })

  /** What husky looks like from git's point of view: `core.hooksPath` aimed
   *  at a directory of hooks, all of which refuse. */
  function installRefusingHooks(): void {
    const hooks = join(root, 'refusing-hooks')
    mkdirSync(hooks)
    for (const name of ['post-checkout', 'post-merge', 'pre-merge-commit', 'commit-msg', 'pre-commit']) {
      const hook = join(hooks, name)
      writeFileSync(hook, '#!/bin/sh\necho "refused by the repository\'s hook" >&2\nexit 1\n')
      chmodSync(hook, 0o755)
    }
    git(['config', 'core.hooksPath', hooks], settings.repo)
  }

  /** The agent's own commits in its lane are the user's commits and DO run
   *  the user's hooks; only Conductor's plumbing is exempt. The test stands
   *  in for the agent, so it makes its commits the way an agent that
   *  respected the hooks would have to. */
  function commitPastHooks(cwd: string, file: string, body: string, message: string): void {
    writeFileSync(join(cwd, file), body)
    git(['-c', 'core.hooksPath=/dev/null', 'add', '.'], cwd)
    git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message], cwd)
  }

  // H1: `git worktree add` runs post-checkout and — unlike `git checkout` —
  // its exit status decides the command's, so a refusing hook left the
  // integration worktree uncreated and every publish dead.
  // H2/H3: a true merge commit runs pre-merge-commit and commit-msg, so a
  // refusing hook turned every non-fast-forward publication into a failure.
  it('creates worktrees, merges and syncs even when every hook in the repository refuses', async () => {
    installRefusingHooks()

    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    expect(existsSync(join(settings.integrationWorktree, '.git'))).toBe(true)

    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })
    expect(existsSync(join(a.worktree, '.git'))).toBe(true)
    commitPastHooks(a.worktree, 'a.txt', 'A\n', 'a work')
    commitPastHooks(b.worktree, 'b.txt', 'B\n', 'b work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch as string], settings.repo), base)
    expect(first).toMatchObject({ ok: true, fastForward: true })
    if (!first.ok) return

    // Both sides moved, so this one is a real merge COMMIT — the case
    // pre-merge-commit and commit-msg refuse.
    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch as string], settings.repo),
      first.resultSha
    )
    expect(second).toMatchObject({ ok: true, fastForward: false })
    if (!second.ok) return

    // And the merge INTO a lane, which is the same commit-making merge in
    // the other direction.
    expect(await lanes.syncLane(a, second.resultSha)).toMatchObject({ ok: true })
  })
}, { timeout: 30_000 })

// Wave 7, F-16: `lane.branch` is read back from the saved store, an
// ordinary JSON file, and went to `git branch -d` unchecked.
describe('the branch a destroy is allowed to delete', () => {
  it('refuses a recorded branch that is not one Conductor created, before removing anything', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    // Fully merged into HEAD, so `branch -d` would have deleted it outright.
    git(['branch', 'users-feature'], settings.repo)

    const tampered = { ...lane, branch: 'users-feature' }
    await expect(lanes.destroy(tampered, { force: true })).rejects.toThrow(/crew\/lane/)

    expect(git(['rev-parse', '--verify', 'users-feature'], settings.repo).length).toBeGreaterThan(0)
    // Refused before the worktree removal, so nothing is half-destroyed.
    expect(existsSync(join(lane.worktree, '.git'))).toBe(true)
  })

  it('still deletes the lane’s own branch when the recorded name is Conductor’s', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    await lanes.destroy(lane, { force: true })

    expect(existsSync(lane.worktree)).toBe(false)
    expect(() => gitExpectFailure(['rev-parse', '--verify', lane.branch as string], settings.repo)).toThrow()
  })
}, { timeout: 30_000 })
