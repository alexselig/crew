// Every git invocation in the conductor lives here, behind a narrow interface,
// so the conductor runtime never shells out itself.

import { mkdir } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGit } from './supervise'
import type { ConductorLane, ConductorSettings, LaneFacts, LaneAgent, MergeResult, PublishResult } from '../shared/conductor'

export interface LaneManager {
  /** Create the Crew-owned integration worktree if absent. Always detached. */
  ensureIntegrationWorktree(): Promise<void>
  create(name: string, agent: LaneAgent): Promise<ConductorLane>
  facts(lane: ConductorLane): Promise<LaneFacts>
  /** Merge the frozen candidate into the base, in the detached integration
   *  worktree. Never rebases: rewriting history strands the lane branch and
   *  makes every later publication replay its own already-landed commits. */
  mergeInIntegration(candidate: string, base: string): Promise<MergeResult>
  /** Bring the integration branch INTO a lane. The only way a lane receives
   *  its teammates' work. Runs only when the lane is quiescent. */
  syncLane(lane: ConductorLane, base: string): Promise<MergeResult>
  /** Compare-and-swap the integration ref. Refuses if any worktree has the
   *  branch checked out. */
  publish(newSha: string, expectedOld: string): Promise<PublishResult>
  destroy(lane: ConductorLane, opts: { force: boolean }): Promise<void>
}

class GitError extends Error {
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'no stderr'}`)
    this.name = 'GitError'
  }
}

// macOS puts the system temp dir behind a /var -> /private/var symlink, so
// git's own path (fully resolved) can differ textually from a caller's
// settings.integrationWorktree even when they name the same directory.
// Wave 5, F-7: `realpathSync.native` rather than `realpathSync`, because
// only the native call returns the true on-disk casing — the plain one
// leaves a path whose letters differ from the volume's own spelling
// untouched, so a settings path typed `/Users/.../Crew` against a folder
// git reports as `/Users/.../crew` compared unequal and EVERY publish then
// refused. This is the rule already settled for samePath() in
// conductor-runtime.ts. A realpath failure falls back to the path as given:
// the comparison then almost certainly fails, which is a refusal, and
// refusing is the safe direction.
const realOrSelf = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    // The leaf may simply not exist yet (or any more — F-8's deleted
    // integration folder is exactly that case), while everything above it
    // does. Resolving the parent and re-attaching the name keeps a missing
    // folder comparable with the path git reports for it; `.`/`..` leaves
    // are left alone, because re-attaching those would be a lexical
    // collapse through a segment nothing has proved exists.
    const parent = dirname(path)
    const leaf = basename(path)
    if (parent === path || leaf === '.' || leaf === '..') return path
    try {
      return join(realpathSync.native(parent), leaf)
    } catch {
      return path
    }
  }
}

/** What `dir` is meant to be, for the refusal message. Both kinds are
 *  Conductor-owned linked worktrees; only the words differ. */
export type OwnedWorktreeKind = 'integration worktree' | 'lane worktree'

/** Wave 6, B-5: `lstat`, never `stat` — the question is what the NAME is,
 *  not what it leads to. A path that does not exist is not a symlink; a
 *  dangling one is. */
const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Wave 6, B-5 (A8/A8a/A8p): every other half of this guard resolves
 *  symlinks before comparing, which is right for `/var` -> `/private/var`
 *  and fatal for a symlink planted where a Conductor worktree belongs:
 *  `realOrSelf` resolved it on BOTH sides, so the check compared the user's
 *  own worktree with itself and said yes — and a real worktree of theirs
 *  has a perfectly correct back-pointer, so the second half said yes too.
 *  Publish then returned `ok: true` while the forced checkout detached the
 *  user's HEAD, the merge overwrote their index and `clean -fd` deleted
 *  their untracked files.
 *
 *  Conductor creates its worktrees with `git worktree add`, which makes
 *  real directories; a symlink at the leaf, or at the folder containing it
 *  (A8p aims the WORKSPACE folder elsewhere), is therefore never something
 *  Conductor made. It is checked with `lstat` on the lexically resolved
 *  path, BEFORE any realpath call can resolve the deception away. Only the
 *  leaf and its parent: Conductor derives those two, while the directories
 *  above them are the platform's (`/var` -> `/private/var` on macOS is a
 *  symlinked ancestor of every temp path) and refusing on those would
 *  reject every legitimate workspace. */
const isSymlinkedPath = (dir: string): boolean => {
  const resolved = resolve(dir)
  return isSymlink(resolved) || isSymlink(dirname(resolved))
}

/** Wave 5, B-4: `--show-toplevel` alone only proves that *some* `.git` entry
 *  sits at `dir` — it reports `dir` itself even when that `.git` file points
 *  its gitdir at the user's own repository (or at one of the user's linked
 *  worktrees), in which case every command Conductor runs there operates on
 *  the USER's index, HEAD and MERGE_HEAD. The back-pointer is what makes the
 *  answer load-bearing: a worktree git itself created has an administrative
 *  directory containing a `gitdir` file naming the `.git` file that points
 *  back at it. The user's main repository has no such file at all, and a
 *  user worktree's file names the USER's folder — so both are rejected. */
async function hasBackPointerTo(dir: string): Promise<boolean> {
  const gitDir = await runGit(['rev-parse', '--absolute-git-dir'], { cwd: dir })
  if (gitDir.code !== 0) return false
  const administrative = gitDir.stdout.trim()
  if (administrative.length === 0) return false
  let backPointer: string
  try {
    backPointer = readFileSync(join(administrative, 'gitdir'), 'utf8').trim()
  } catch {
    // No `gitdir` file: `dir` is not a linked worktree of anything, so the
    // `.git` entry at it belongs to some other repository's layout.
    return false
  }
  if (backPointer.length === 0) return false
  // Wave 6, B-6 (A12): with `worktree.useRelativePaths` (git >= 2.48) git
  // writes this file as a path RELATIVE to the administrative directory
  // holding it (`../../../../integration/.git`). Resolving it against
  // `process.cwd()` — whatever directory Crew's main process happens to
  // have been started in — made it name a directory that does not exist,
  // so the guard said no to Conductor's own worktrees and every publish
  // and sync in the workspace failed with the wrong message. An absolute
  // back-pointer is unaffected: `resolve` returns it unchanged.
  return realOrSelf(resolve(administrative, backPointer)) === realOrSelf(join(dir, '.git'))
}

/** Wave 4, B-2: true only when `dir` is the root of the git worktree git
 *  itself resolves from `dir`. git searches UPWARDS for a repository, so a
 *  Conductor-owned folder that has lost its `.git` file resolves to
 *  whatever repository happens to enclose it — and every destructive
 *  command Conductor then runs there (`merge --abort`, a forced checkout)
 *  lands in the user's own repository instead of in Crew's scratch
 *  worktree. Compared after resolving symlinks, because
 *  `rev-parse --show-toplevel` always reports the fully resolved path while
 *  the configured one need not be.
 *
 *  Wave 5, B-4: and only when git's own administrative directory for `dir`
 *  points back at `<dir>/.git` — see hasBackPointerTo. Without that second
 *  half a `.git` file aimed into the user's repository passed this check
 *  and the repair then wiped the user's merge state while reporting
 *  success. */
export async function isOwnWorktree(dir: string): Promise<boolean> {
  // Wave 6, B-5: first, and before any realpath call — see isSymlinkedPath.
  if (isSymlinkedPath(dir)) return false
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir })
  if (top.code !== 0) return false
  const reported = top.stdout.trim()
  if (reported.length === 0) return false
  if (realOrSelf(reported) !== realOrSelf(dir)) return false
  return hasBackPointerTo(dir)
}

/** The message `isOwnWorktree` failing earns. Shared so the lane manager and
 *  the conductor's Acknowledge repair refuse in the same words. */
export function notOwnWorktreeMessage(dir: string, kind: OwnedWorktreeKind = 'integration worktree'): string {
  // Wave 5, F-8 (A5): a folder that simply is not there earned the
  // "resolves to some enclosing repository" wording, which sent the user
  // looking for a mid-merge repo that does not exist. Say what is actually
  // wrong.
  if (!existsSync(dir)) {
    return (
      `the ${kind} at ${dir} does not exist, so no git command may be run in it; refusing to touch it`
    )
  }
  // Wave 6, B-5: a symlink is never something `git worktree add` created,
  // so saying "it resolves to some enclosing repository" would send the
  // user looking for a repository that has nothing to do with it.
  if (isSymlinkedPath(dir)) {
    return (
      `the ${kind} at ${dir} is a symbolic link (or sits directly inside one), which is never something ` +
      'Conductor created, so no git command may be run in it; refusing to touch it'
    )
  }
  // Wave 6, F-8 (A15): a folder that is simply EMPTY of git earned the
  // "resolves to some enclosing repository" wording too, even where no
  // enclosing repository exists — and it left the user with no stated way
  // out, while every later publish failed identically. Conductor may not
  // re-create this folder itself (wave 4, B-2: it may be full of somebody's
  // work), so the message has to carry the recovery.
  if (!existsSync(join(dir, '.git'))) {
    return (
      `the ${kind} at ${dir} is not a Conductor worktree: it has no .git entry, so git run there would ` +
      'act on whatever repository the folder happens to sit inside; refusing to touch it. Conductor will ' +
      'not re-create it for you, because it may hold work: move anything you need out of that folder and ' +
      `delete it (or run \`git worktree repair ${dir}\` from the repository if it was a worktree), then ` +
      'publish again.'
    )
  }
  return (
    `the ${kind} at ${dir} is not a git worktree of its own — git there resolves to some ` +
    'enclosing repository, so no git command may be run in it; refusing to touch it'
  )
}

async function requireOwnWorktree(dir: string, kind: OwnedWorktreeKind = 'integration worktree'): Promise<void> {
  if (!(await isOwnWorktree(dir))) throw new Error(notOwnWorktreeMessage(dir, kind))
}

export function createLaneManager(settings: ConductorSettings): LaneManager {
  const inRepo = async (args: string[], timeoutMs?: number): Promise<string> => {
    const result = await runGit(args, { cwd: settings.repo, timeoutMs })
    if (result.code !== 0) throw new GitError(args, result.stderr)
    return result.stdout.trim()
  }

  const inDir = async (cwd: string, args: string[], timeoutMs?: number): Promise<string> => {
    const result = await runGit(args, { cwd, timeoutMs })
    if (result.code !== 0) throw new GitError(args, result.stderr)
    return result.stdout.trim()
  }

  // macOS puts the system temp dir behind a /var -> /private/var symlink, so
  // git's own path (fully resolved) can differ textually from a caller's
  // settings.integrationWorktree even when they name the same directory.
  const ensureIntegrationWorktree = async (): Promise<void> => {
    const list = await inRepo(['worktree', 'list', '--porcelain'])
    const target = realOrSelf(settings.integrationWorktree)
    const already = list
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .some((line) => realOrSelf(line.slice('worktree '.length)) === target)
    // Wave 5, F-8: "git still lists it" is not "it is there". A deleted or
    // never-created folder stays in `worktree list` (marked prunable) until
    // somebody runs `git worktree prune`, so returning early on `already`
    // alone left the run in a state no Conductor action could leave: every
    // publish died in the missing folder and the only way out was a manual
    // git command. The registration is re-used rather than pruned — `add
    // --force` re-creates the folder for a path git already knows about.
    // Only an ABSENT folder is re-created: a folder that is present but has
    // lost its `.git` file is the wave-4 B-2 case, where the safe answer is
    // to refuse (that folder may be full of somebody's work), not to run
    // git in it.
    const present = existsSync(settings.integrationWorktree)
    if (already && present) return
    const base = await inRepo(['rev-parse', settings.integrationBranch])
    // --detach is the whole design: integrationBranch is checked out nowhere,
    // so update-ref can advance it without desynchronising any working copy,
    // and the user stays free to check it out themselves.
    // Wave 6, F-14: `--force` twice, not once. A single force is refused
    // outright for "a missing but locked worktree" — git names `add -f -f`
    // in its own error — and a locked registration outlives the folder, so
    // one force left the workspace with no way forward from the panel. The
    // second force only overrides the lock and the missing folder: the add
    // is `--detach`, so it is never claiming a branch from anybody.
    await inRepo([
      'worktree', 'add', ...(already ? ['--force', '--force'] : []), '--detach', settings.integrationWorktree, base
    ])
  }

  const create = async (name: string, agent: LaneAgent): Promise<ConductorLane> => {
    await mkdir(settings.lanesDir, { recursive: true })
    const branch = `crew/lane/${name}`
    const worktree = join(settings.lanesDir, name)
    const base = await inRepo(['rev-parse', settings.integrationBranch])
    await inRepo(['worktree', 'add', '-b', branch, worktree, base])
    try {
      // Sets the merge target `branch -d` uses at destroy time: without an
      // upstream, git's "fully merged" check falls back to whatever HEAD
      // happens to be in settings.repo, which has nothing to do with
      // integrationBranch and is not even guaranteed to exist.
      await inRepo(['branch', '--set-upstream-to', settings.integrationBranch, branch])
    } catch (err) {
      // A half-created lane (worktree + branch but no upstream) is worse than
      // no lane: it looks finished. Unwind both before propagating the real
      // failure, and never let a cleanup error mask it.
      try {
        await inRepo(['worktree', 'remove', '--force', worktree])
      } catch {
        /* best-effort; the original error is what matters */
      }
      try {
        await inRepo(['branch', '-D', branch])
      } catch {
        /* best-effort; the original error is what matters */
      }
      throw err
    }
    return {
      id: randomUUID(),
      roleId: name,
      // Phase 1 creates authors only; see ConductorLane.kind.
      kind: 'author',
      agent,
      worktree,
      branch,
      sessionId: null,
      status: 'working',
      dispatches: 0
    }
  }

  const requireBranch = (lane: ConductorLane, operation: string): string => {
    if (lane.branch === null) {
      throw new Error(`lane ${lane.roleId} has no branch (reviewer lane, detached); cannot ${operation}`)
    }
    return lane.branch
  }

  /** Wave 6, F-12 (A8b): `lane.worktree` is read back from the saved store,
   *  which is an ordinary JSON file on disk. A tampered (or merely stale)
   *  entry naming one of the user's own worktrees made `syncLane`
   *  fast-forward the user's branch and `destroy({ force: true })` delete
   *  their worktree, uncommitted file and all. Two things are proved before
   *  either runs:
   *
   *  1. the path really is inside `settings.lanesDir` — with
   *     `path.relative`, never `startsWith`, because `/lanes-evil` starts
   *     with `/lanes`;
   *  2. it belongs to the repository Conductor is conducting, by comparing
   *     git's own `--git-common-dir` for it with the repo's. Containment
   *     alone is not enough: `git worktree add` from ANY repository can
   *     plant a worktree inside Crew's folder.
   *
   *  `isOwnWorktree` on top of that is what proves the folder is a worktree
   *  root at all (and, since wave 6 B-5, that it is not a symlink). */
  const requireOwnLaneWorktree = async (lane: ConductorLane): Promise<void> => {
    const worktree = lane.worktree
    // Ownership first: it is the check that refuses a symlink, and it must
    // reach that verdict before `realOrSelf` below resolves the deception
    // into a plain "outside the lanes folder" — a refusal either way, but
    // one that names the wrong problem.
    await requireOwnWorktree(worktree, 'lane worktree')
    const rel = relative(realOrSelf(settings.lanesDir), realOrSelf(worktree))
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `lane ${lane.roleId} names a worktree at ${worktree}, which is not inside Conductor's lanes folder ` +
          `(${settings.lanesDir}); refusing to touch it`
      )
    }
    const [laneCommon, ourCommon] = await Promise.all([
      inDir(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      inRepo(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ])
    if (realOrSelf(laneCommon) !== realOrSelf(ourCommon)) {
      throw new Error(
        `lane ${lane.roleId} names a worktree at ${worktree} that belongs to another repository ` +
          `(${laneCommon}, not ${ourCommon}); refusing to touch it`
      )
    }
  }

  const facts = async (lane: ConductorLane): Promise<LaneFacts> => {
    const laneBranch = requireBranch(lane, 'compute facts')
    const [counts, tracked, all, laneTip, baseSha] = await Promise.all([
      // left = on base not lane (behind), right = on lane not base (ahead).
      inRepo(['rev-list', '--left-right', '--count', `${settings.integrationBranch}...${laneBranch}`]),
      inDir(lane.worktree, ['status', '--porcelain', '--untracked-files=no']),
      inDir(lane.worktree, ['status', '--porcelain', '--untracked-files=normal']),
      inRepo(['rev-parse', laneBranch]),
      inRepo(['rev-parse', settings.integrationBranch])
    ])
    const [behind, ahead] = counts.split(/\s+/).map((n) => Number(n) || 0)
    return {
      ahead,
      behind,
      dirtyTracked: tracked.length > 0,
      untracked: all.split('\n').some((line) => line.startsWith('??')),
      laneTip,
      baseSha
    }
  }

  // git reports conflicted paths as unmerged index entries; --diff-filter=U is
  // the only listing that survives `merge --abort`, so it must run first.
  const conflictPathsIn = async (cwd: string): Promise<string[]> => {
    const result = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd })
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  }

  const mergeAt = async (cwd: string, target: string, kind: OwnedWorktreeKind): Promise<MergeResult> => {
    // Wave 5, B-3: `merge` and the `merge --abort` below both run with `cwd`
    // as the working directory, and git walks UPWARDS to find a repository.
    // A LANE worktree that has lost its `.git` file inside some other
    // repository therefore made syncLane abort the merge the user was
    // half-way through resolving THERE, and then report that repository's
    // conflicting file as the lane's. mergeInIntegration already proved
    // ownership (clearInterruptedMerge); the lane path proved nothing at
    // all. Proving it here covers both callers, and fails closed.
    await requireOwnWorktree(cwd, kind)
    const merge = await runGit(['merge', '--no-edit', target], { cwd, timeoutMs: 60_000 })
    if (merge.code === 0) {
      const resultSha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
      return { ok: true, resultSha, fastForward: resultSha === target }
    }

    // A non-zero exit alone proves nothing: a bad revision, a dirty
    // worktree, a timeout, or a merge-strategy failure all exit non-zero
    // with no unmerged paths, and must never be reported as a conflict.
    const conflictPaths = await conflictPathsIn(cwd)
    if (conflictPaths.length === 0) {
      throw new GitError(['merge', '--no-edit', target], merge.stderr || merge.stdout)
    }

    // Genuine conflict: abort unconditionally. The lock is never held across
    // a conflict, so leaving MERGE_HEAD behind would trip the next
    // publication instead. A failed abort is worse than the conflict itself:
    // it strands the integration worktree in MERGING state for everyone
    // after us, so it must never be swallowed as though it were a conflict.
    const abort = await runGit(['merge', '--abort'], { cwd })
    if (abort.code !== 0) {
      const originalFailure = merge.stderr.trim() || merge.stdout.trim() || 'no output'
      const abortFailure = abort.stderr.trim() || abort.stdout.trim() || 'no output'
      throw new GitError(
        ['merge', '--abort'],
        `integration worktree at ${cwd} needs manual attention: original merge of ${target} failed (${originalFailure}), ` +
          `conflicting paths: ${conflictPaths.join(', ')}; merge --abort then also failed (${abortFailure})`
      )
    }
    return {
      ok: false,
      conflictPaths,
      message: merge.stderr.trim() || merge.stdout.trim() || 'merge failed'
    }
  }

  // Wave 3, finding 3: a crash in the window between a conflicting `git
  // merge` and the `--abort` below leaves MERGE_HEAD and an unmerged index
  // in the integration worktree, and every later publication then dies on
  // `checkout --detach` with "you need to resolve your current index first"
  // — a failure the user cannot act on from the panel, on a worktree
  // Conductor owns outright and no human is supposed to be editing. So the
  // wedge is cleared here, before anything else touches the worktree:
  // abort the merge if one is in progress, then hard-reset and clean so the
  // checkout that follows starts from the pinned base and nothing else.
  // Only reached when the worktree is actually wedged or dirty, so an
  // ordinary publication's git work is unchanged.
  const clearInterruptedMerge = async (base: string): Promise<void> => {
    const cwd = settings.integrationWorktree
    // Wave 4, B-2: every git command below runs with `cwd` as the working
    // directory, and git walks UPWARDS to find a repository. If the
    // integration folder has lost its `.git` file and happens to sit inside
    // another repository, `merge --abort` (and the checkout after it) land
    // in that repository instead — throwing away a half-resolved conflict
    // the user owns. Prove the folder really is its own worktree before
    // touching git at all, and fail closed when it is not.
    await requireOwnWorktree(cwd)
    const mergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd })
    const merging = mergeHead.code === 0 && mergeHead.stdout.trim().length > 0
    if (merging) {
      // A failed abort is not fatal here: the reset below clears MERGE_HEAD
      // and the index either way, and it reports its own failure if it
      // cannot.
      await runGit(['merge', '--abort'], { cwd })
    }
    const status = await runGit(['status', '--porcelain', '--untracked-files=no'], { cwd })
    if (!merging && status.stdout.trim().length === 0) return
    // Wave 4, B-1: `reset --hard <base>` moves whatever ref HEAD points at.
    // The integration worktree is normally detached, but nothing guarantees
    // it — the user can check a branch out in it, and git never stops them.
    // A repair that rewinds their branch (and, when the operation had
    // already published, the merge commit on it) is the one thing this
    // branch's transaction must never do. `checkout --force --detach` puts
    // the working tree and index exactly where a hard reset would, clearing
    // MERGE_HEAD and any unmerged entries with it, while moving no ref at
    // all.
    await inDir(cwd, ['checkout', '--force', '--detach', base])
    await inDir(cwd, ['clean', '-fd'])
  }

  const mergeInIntegration = async (candidate: string, base: string): Promise<MergeResult> => {
    await ensureIntegrationWorktree()
    await clearInterruptedMerge(base)
    // Detach at the pinned base every time. The worktree may be sitting at the
    // result of an earlier publication, and publication must be against the
    // base the caller pinned, not "wherever this worktree happens to be".
    await inDir(settings.integrationWorktree, ['checkout', '--detach', base])
    return mergeAt(settings.integrationWorktree, candidate, 'integration worktree')
  }

  const syncLane = async (lane: ConductorLane, base: string): Promise<MergeResult> => {
    // A reviewer lane is detached at a candidate SHA and owns no branch;
    // merging into it there would strand commits nothing ever tracks.
    const branch = requireBranch(lane, 'sync')
    await requireOwnLaneWorktree(lane)
    // Wave 6, F-12 (A9): `merge` writes wherever HEAD points, and nothing
    // stops the agent living in this worktree from checking one of the
    // user's own branches out in it. Conductor would then fast-forward that
    // branch into the integration base — a write to a ref the user owns,
    // which this feature never does. The lane's own branch is the only ref
    // sync may move.
    const head = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd: lane.worktree })
    const at = head.code === 0 ? head.stdout.trim() : '(detached HEAD)'
    if (at !== `refs/heads/${branch}`) {
      throw new Error(
        `lane ${lane.roleId} is on ${at}, not ${branch}; syncing there would move a ref Conductor does not ` +
          'own, so refusing to touch it'
      )
    }
    return mergeAt(lane.worktree, base, 'lane worktree')
  }

  const branchIsCheckedOut = async (): Promise<boolean> => {
    const list = await inRepo(['worktree', 'list', '--porcelain'])
    return list.split('\n').some((line) => line.trim() === `branch refs/heads/${settings.integrationBranch}`)
  }

  const publish = async (newSha: string, expectedOld: string): Promise<PublishResult> => {
    // Immediately before the CAS: update-ref on a branch that is somebody's
    // HEAD advances the ref and leaves their index and files behind it.
    if (await branchIsCheckedOut()) {
      return {
        ok: false,
        reason: 'branch-checked-out',
        message: `${settings.integrationBranch} is checked out in a worktree; refusing to publish`
      }
    }

    const ref = `refs/heads/${settings.integrationBranch}`
    // The three-argument form IS the compare-and-swap: git refuses unless the
    // ref still equals expectedOld.
    const cas = await runGit(['update-ref', ref, newSha, expectedOld], { cwd: settings.repo })
    if (cas.code !== 0) {
      const current = await inRepo(['rev-parse', settings.integrationBranch])
      return {
        ok: false,
        reason: current === expectedOld ? 'error' : 'ref-moved',
        message: cas.stderr.trim() || `expected ${expectedOld}, found ${current}`
      }
    }

    // The CAS has already mutated the ref. If this step throws, the branch
    // must not be left advanced while publish() reports failure — that is a
    // torn write. Roll the ref back to expectedOld before propagating.
    try {
      const diff = await inRepo(['diff', '--name-only', expectedOld, newSha])
      return {
        ok: true,
        commit: newSha,
        touchedPaths: diff.split('\n').map((line) => line.trim()).filter(Boolean)
      }
    } catch (err) {
      const originalFailure = err instanceof Error ? err.message : String(err)
      const rollback = await runGit(['update-ref', ref, expectedOld, newSha], { cwd: settings.repo })
      if (rollback.code !== 0) {
        const rollbackFailure = rollback.stderr.trim() || rollback.stdout.trim() || 'no output'
        throw new Error(
          `${ref} at ${settings.repo} needs manual attention: publish of ${newSha} failed after the ref was ` +
            `already advanced (${originalFailure}); rolling back to ${expectedOld} then also failed (${rollbackFailure})`
        )
      }
      throw err
    }
  }

  const destroy = async (lane: ConductorLane, opts: { force: boolean }): Promise<void> => {
    // Before the status read as well as the removal: `worktree remove
    // --force` deletes the folder outright, so a store entry naming the
    // user's own worktree must never reach it.
    await requireOwnLaneWorktree(lane)
    if (!opts.force) {
      const dirty = await inDir(lane.worktree, ['status', '--porcelain', '--untracked-files=no'])
      if (dirty.length > 0) {
        // A refused destroy must not leave the run holding anything; this
        // throws before any mutation, so there is nothing to unwind.
        throw new Error(`lane ${lane.roleId} has uncommitted changes; destroy refused`)
      }
    }
    await inRepo(['worktree', 'remove', ...(opts.force ? ['--force'] : []), lane.worktree])

    if (lane.branch === null) return
    // -d, never -D: git refuses when the branch is not fully merged, and that
    // refusal is the desired outcome here — unpublished commits survive the
    // destroy rather than being silently discarded. force only reaches the
    // worktree removal above, never this branch delete.
    const result = await runGit(['branch', '-d', lane.branch], { cwd: settings.repo })
    if (result.code !== 0 && !/not fully merged/.test(result.stderr)) {
      throw new GitError(['branch', '-d', lane.branch], result.stderr)
    }
  }

  return { ensureIntegrationWorktree, create, facts, mergeInIntegration, syncLane, publish, destroy }
}
