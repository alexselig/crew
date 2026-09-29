// Every git invocation in the conductor lives here, behind a narrow interface,
// so the conductor runtime never shells out itself.

import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGit } from './supervise'
import type { ConductorLane, ConductorSettings, LaneFacts, LaneAgent, MergeResult } from '../shared/conductor'

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
  destroy(lane: ConductorLane, opts: { force: boolean }): Promise<void>
}

class GitError extends Error {
  constructor(args: string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || 'no stderr'}`)
    this.name = 'GitError'
  }
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
  const realOrSelf = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }

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
    if (merge.code !== 0) {
      const conflictPaths = await conflictPathsIn(cwd)
      // Abort unconditionally: the lock is never held across a conflict, so
      // leaving MERGE_HEAD behind would trip the next publication instead.
      await runGit(['merge', '--abort'], { cwd })
      return {
        ok: false,
        conflictPaths,
        message: merge.stderr.trim() || merge.stdout.trim() || 'merge failed'
      }
    }
    const resultSha = (await runGit(['rev-parse', 'HEAD'], { cwd })).stdout.trim()
    return { ok: true, resultSha, fastForward: resultSha === target }
  }

  const mergeInIntegration = async (candidate: string, base: string): Promise<MergeResult> => {
    await ensureIntegrationWorktree()
    // Detach at the pinned base every time. The worktree may be sitting at the
    // result of an earlier publication, and publication must be against the
    // base the caller pinned, not "wherever this worktree happens to be".
    await inDir(settings.integrationWorktree, ['checkout', '--detach', base])
    return mergeAt(settings.integrationWorktree, candidate)
  }

  const syncLane = async (lane: ConductorLane, base: string): Promise<MergeResult> =>
    mergeAt(lane.worktree, base)

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

  return { ensureIntegrationWorktree, create, facts, mergeInIntegration, syncLane, destroy }
}
