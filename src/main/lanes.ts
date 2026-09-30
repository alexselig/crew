// Every git invocation in the conductor lives here, behind a narrow interface,
// so the conductor runtime never shells out itself.

import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
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
const realOrSelf = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Wave 4, B-2: true only when `dir` is the root of the git worktree git
 *  itself resolves from `dir`. git searches UPWARDS for a repository, so a
 *  Conductor-owned folder that has lost its `.git` file resolves to
 *  whatever repository happens to enclose it — and every destructive
 *  command Conductor then runs there (`merge --abort`, a forced checkout)
 *  lands in the user's own repository instead of in Crew's scratch
 *  worktree. Compared after resolving symlinks, because
 *  `rev-parse --show-toplevel` always reports the fully resolved path while
 *  the configured one need not be. */
export async function isOwnWorktree(dir: string): Promise<boolean> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir })
  if (top.code !== 0) return false
  const reported = top.stdout.trim()
  if (reported.length === 0) return false
  return realOrSelf(reported) === realOrSelf(dir)
}

/** The message `isOwnWorktree` failing earns. Shared so the lane manager and
 *  the conductor's Acknowledge repair refuse in the same words. */
export function notOwnWorktreeMessage(dir: string): string {
  return (
    `the integration worktree at ${dir} is not a git worktree of its own — git there resolves to some ` +
    'enclosing repository, so no git command may be run in it; refusing to touch it'
  )
}

async function requireOwnWorktree(dir: string): Promise<void> {
  if (!(await isOwnWorktree(dir))) throw new Error(notOwnWorktreeMessage(dir))
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
    if (already) return
    const base = await inRepo(['rev-parse', settings.integrationBranch])
    // --detach is the whole design: integrationBranch is checked out nowhere,
    // so update-ref can advance it without desynchronising any working copy,
    // and the user stays free to check it out themselves.
    await inRepo(['worktree', 'add', '--detach', settings.integrationWorktree, base])
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

  const mergeAt = async (cwd: string, target: string): Promise<MergeResult> => {
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
    return mergeAt(settings.integrationWorktree, candidate)
  }

  const syncLane = async (lane: ConductorLane, base: string): Promise<MergeResult> => {
    // A reviewer lane is detached at a candidate SHA and owns no branch;
    // merging into it there would strand commits nothing ever tracks.
    requireBranch(lane, 'sync')
    return mergeAt(lane.worktree, base)
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
