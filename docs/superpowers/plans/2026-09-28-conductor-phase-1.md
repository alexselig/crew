# Conductor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the git safety layer that lets two agent lanes work on one repository and land their work through a single-flight, crash-recoverable, merge-based publication — triggered manually by the user, with no agent automation. Plus the way a conducted workspace comes into existence: a composer that creates the lanes and their sessions, and the deterministic half of the agent-proposed roster.

**Architecture:** Lane worktrees each on their own branch; a Crew-owned integration worktree whose HEAD is permanently detached; publication is merge → test → journal → compare-and-swap of the integration ref. Every git child runs in its own process group under a supervisor that resolves only on confirmed exit, and the publication lock is released only after that promise settles. A two-write journal makes every crash point classifiable on restart.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, Vitest, real `git` via `child_process.spawn`.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-09-28-conducted-workspaces-design.md`. Every task's requirements implicitly include this section.

- **Phase 1 has no agent automation.** No PTY injection, no LLM briefings, no bulletins that instruct git, no question relay, no detector-triggered automation. The only triggers are the user's buttons.
- **Only Crew moves the integration ref.** What an agent does on its own lane branch is its business.
- **Never rebase.** Publication merges. Rewriting history strands the lane branch and makes every subsequent publication replay already-landed commits.
- **The integration worktree's HEAD is permanently detached**, and `integrationBranch` is deliberately checked out nowhere.
- **The user's own checkout is never a merge target.**
- All git runs with `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true`. An editor or credential prompt with no TTY hangs until the timeout, which is precisely the lost-lock failure.
- **Crew never runs `git add -A` on an agent's behalf** — it cannot know what belongs in the commit.
- **Uncommitted and untracked files warn, they never block.** Publication operates on a frozen commit, so a dirty working tree cannot leak into it.
- **The lock is released on every exit path**, and only after the git child is confirmed exited. A timeout that clears ownership while `git merge` is still running is a double-grant, not a recovery.
- **Persistence failure must fail closed** and prevent the effect, rather than reporting success from memory.
- **A run never auto-resumes.** On launch it enters `needs-recovery` and reconciles the journal against reality.
- **`maxLanes` default: 2**, three opt-in.
- Tests live flat in `test/<name>.test.ts`, run by `npx vitest run`. There is **no `npm run lint`** — the gate is `npm run typecheck`, `npx vitest run`, `npm run build`.
- Real git is required for lane-manager tests; merge metadata and ref semantics cannot be faked credibly.

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/conductor.ts` | Phase 1 types only. No IO, no imports from `main/`. |
| `src/main/supervise.ts` | Run one child in its own process group; resolve only on confirmed exit. Generic, so the test recipe runner reuses it. |
| `src/main/lanes.ts` | Every git invocation in the feature. The conductor never shells out itself. |
| `src/main/conductor-journal.ts` | The bounded, own-file, fail-closed journal. |
| `src/shared/conductor-recovery.ts` | Pure crash classifier — journal + observed reality → one classification. |
| `src/shared/conductor-membership.ts` | Pure exclusivity validator over workspaces and sessions. |
| `src/main/conductor.ts` | The single-flight lock and the 11-step publication transaction. Orchestration only. |
| `src/renderer/conductor-view-model.ts` | Pure presentation logic — what the roster shows, which buttons are enabled. |
| `src/renderer/components/ConductorPanel.tsx` | Thin React shell over the view model. |
| `src/shared/conductor-composer.ts` | Pure roster validation — everything decidable before anything is created. |
| `src/main/conductor-compose.ts` | Creates a conducted workspace: integration worktree, then a lane and a session per row, all-or-nothing. |
| `src/shared/conductor-proposal.ts` | Pure parse + reconcile of an agent-written roster against the live model catalogue and installed presets. |
| `src/renderer/components/ConductorComposer.tsx` | The creation form. Opens empty, or pre-filled from a proposal. |
| `src/renderer/conductor-plan-document.ts` | Pure: arranges a reconciled proposal for reading — bands, roster rows, notes attached to the rows they concern. |
| `src/renderer/components/ConductorPlanDialog.tsx` | Renders that document. Escaped text only; never renders agent-supplied markup. |

**The new-session dialog is not modified by any task in this plan.** Conducting is a property of the workspace, so the composer lives in the workspace creation flow; every ordinary session in Crew, including ordinary sessions inside a conducted workspace, behaves exactly as it does today.

Splitting the crash classifier, the view model, the roster validator and the proposal reconciler into pure `shared/` and pure renderer modules is deliberate: both encode rules that need exhaustive tests, and neither should require a browser or a temp repo to test.

---

### Task 1: Shared types and the process supervisor — DONE (`c21045b`)

> Implemented and verified: 7/7 tests pass, typecheck clean. One deviation:
> `Classification` is declared in `src/shared/conductor.ts` rather than in
> `conductor-recovery.ts` (Task 6), so this base module depends on nothing and
> typecheck stays green ahead of that task. Task 6 imports it from there.

**Files:**
- Create: `src/shared/conductor.ts`
- Create: `src/main/supervise.ts`
- Test: `test/supervise.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LaneFacts`, `MergeResult`, `PublishResult`, `ConductorLane`, `ConductorSettings`, `LaneStatus`, `RoleKind`, `LaneAgent`, and the IPC payload types from `src/shared/conductor.ts`; `runSupervised(command, args, opts) => Promise<SupervisedResult>`, `runGit(args, opts) => Promise<SupervisedResult>`, `NON_INTERACTIVE_GIT_ENV` from `src/main/supervise.ts`.

- [x] **Step 1: Write the shared types**

Create `src/shared/conductor.ts`:

```ts
// Phase 1 conductor types. Pure data: no IO, no imports from main/.
// Phase 2 types (Role, Edge, Pipeline, Review, GateId) are specified in the
// design doc but deliberately NOT implemented here — Phase 1's Publish button
// is manual, so the human is the review gate.

export type LaneStatus = 'working' | 'publishing' | 'blocked' | 'done'

/** Which agent, and which mind, runs this lane. */
export interface LaneAgent {
  /** A Crew preset id: 'copilot-cli' | 'claude-code' | 'shell'. */
  presetId: string
  /** Copilot CLI only. An id from the CLI's own catalogue, or null to take the
   *  CLI default. Never a hardcoded list — see listCopilotModels(). */
  model: string | null
}

export type RoleKind = 'author' | 'reviewer'

export interface ConductorLane {
  id: string
  /** The role this lane serves. Also names its branch and its worktree dir. */
  roleId: string
  /** Collected and stored in Phase 1; every Phase 1 lane behaves as an author,
   *  because nothing evaluates a review yet. */
  kind: RoleKind
  agent: LaneAgent
  /** Absolute path to this lane's worktree. */
  worktree: string
  /** The lane's own branch. Null for a reviewer, which is detached at the
   *  candidate SHA and owns no branch. Phase 1 creates authors only, so this
   *  is non-null in practice — but the type carries the Phase 2 shape so
   *  persisted data never has to be reshaped. */
  branch: string | null
  /** The Crew session running in this worktree, once the composer spawns it. */
  sessionId: string | null
  status: LaneStatus
  /** Set when status is 'blocked', so the UI never shows a reasonless block. */
  blockedReason?: string
  /** Every dispatch is counted, not only handoffs, so Phase 2's needs-changes
   *  loop is bounded. Always 0 in Phase 1. */
  dispatches: number
}

export interface ConductorSettings {
  /** Absolute path to the user's repository. Never a merge target. */
  repo: string
  integrationBranch: string
  /** Crew-owned worktree, permanently DETACHED. */
  integrationWorktree: string
  /** Where lane worktrees are created. Git-ignored. */
  lanesDir: string
  maxLanes: number
  test: TestRecipe | null
}

export interface TestRecipe {
  /** Run once per integration worktree, keyed on a hash of the lockfile.
   *  Without this the integration worktree has no dependencies installed and
   *  every tests-pass fails on a Node repo. */
  setup?: { command: string; args: string[]; timeoutMs: number }
  command: string
  args: string[]
  /** Relative to the worktree root. */
  cwd: string
  timeoutMs: number
}

export interface LaneFacts {
  /** Commits on the lane branch not on the pinned base. */
  ahead: number
  /** Commits on the base not on the lane branch. */
  behind: number
  /** Tracked modifications only. Advisory — warns, never gates. */
  dirtyTracked: boolean
  /** Untracked files present. Purely informational. */
  untracked: boolean
  /** SHA of the lane branch tip these facts describe. */
  laneTip: string
  /** SHA of integrationBranch these facts were computed against. */
  baseSha: string
}

export type MergeResult =
  | { ok: true; resultSha: string; fastForward: boolean }
  | { ok: false; conflictPaths: string[]; message: string }

export type PublishResult =
  | { ok: true; commit: string; touchedPaths: string[] }
  | { ok: false; reason: 'ref-moved' | 'branch-checked-out' | 'error'; message: string }

// Everything below crosses the IPC boundary and is read by the renderer, which
// must never import from src/main. That is the only reason these live here
// rather than beside the runtime that produces them.

export type PublishFailure =
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'nothing-to-publish' }
  | { ok: false; reason: 'journal-failed'; message: string }
  | { ok: false; reason: 'conflict'; conflictPaths: string[]; message: string }
  | { ok: false; reason: 'tests-failed'; output: string }
  | { ok: false; reason: 'ref-moved' | 'branch-checked-out' | 'error'; message: string }

export type PublishOutcome =
  | { ok: true; commit: string; touchedPaths: string[]; warnings: string[] }
  | PublishFailure

export type SyncOutcome =
  | { ok: true; resultSha: string; fastForward: boolean }
  | { ok: false; reason: 'busy' | 'conflict' | 'error'; conflictPaths?: string[]; message: string }

export interface ReconciledOperation {
  opId: string
  laneId: string
  classification: Classification
  summary: string
  safeToRedo: boolean
  requiresHuman: boolean
}

export interface ReconcileReport {
  needsAttention: boolean
  operations: ReconciledOperation[]
}

export interface ConductorSnapshot {
  enabled: boolean
  /** The lane id holding the publication lock, or null. */
  publishing: string | null
  lanes: ConductorLane[]
  facts: Record<string, LaneFacts>
  needsAttention: boolean
}

export interface LaneCreateRequest {
  roleId: string
  agent: LaneAgent
}
```

`Classification` comes from `src/shared/conductor-recovery.ts` (Task 6), which is also under `src/shared` — no boundary is crossed. Import it at the top of this file once Task 6 exists; until then TypeScript will flag it, which is the correct order of work.

- [x] **Step 2: Write the failing supervisor test**

Create `test/supervise.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runSupervised, runGit, NON_INTERACTIVE_GIT_ENV } from '../src/main/supervise'
import { tmpdir } from 'node:os'

describe('runSupervised', () => {
  it('resolves with stdout and a zero exit code', async () => {
    const r = await runSupervised('sh', ['-c', 'echo hello'], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.timedOut).toBe(false)
  })

  it('captures a non-zero exit code without throwing', async () => {
    const r = await runSupervised('sh', ['-c', 'echo bad >&2; exit 3'], { cwd: tmpdir() })
    expect(r.code).toBe(3)
    expect(r.stderr.trim()).toBe('bad')
  })

  // The reason this supervisor exists. tracker.ts uses execFile with a timeout
  // but no process group, so a wedged git can leave descendants running.
  it('kills the whole process group on timeout, not just the direct child', async () => {
    const r = await runSupervised('sh', ['-c', 'sleep 30 & echo $!; wait'], {
      cwd: tmpdir(),
      timeoutMs: 300,
      graceMs: 200
    })
    expect(r.timedOut).toBe(true)
    const grandchild = Number(r.stdout.trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    // Give the group kill a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  // A timeout that resolves while the child is still alive is a double-grant,
  // not a recovery: the next lane would meet index.lock or a moving ref.
  it('resolves only after the child has actually exited', async () => {
    const r = await runSupervised('sh', ['-c', 'trap "" TERM; sleep 30'], {
      cwd: tmpdir(),
      timeoutMs: 200,
      graceMs: 200
    })
    expect(r.timedOut).toBe(true)
    expect(() => process.kill(r.pid, 0)).toThrow()
  })

  it('reports a missing binary instead of rejecting', async () => {
    const r = await runSupervised('crew-does-not-exist', [], { cwd: tmpdir() })
    expect(r.code).toBeNull()
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })
})

describe('runGit', () => {
  it('runs git non-interactively', async () => {
    const r = await runGit(['--version'], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^git version/)
  })

  it('pins every prompt-capable git knob off', () => {
    expect(NON_INTERACTIVE_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0')
    expect(NON_INTERACTIVE_GIT_ENV.GIT_EDITOR).toBe('true')
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SEQUENCE_EDITOR).toBe('true')
  })
})
```

- [x] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/supervise.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/supervise"`.

- [x] **Step 4: Write the supervisor**

Create `src/main/supervise.ts`:

```ts
// A process supervisor for the conductor. Neither existing pattern in this
// codebase meets the requirement:
//   - tracker.ts uses execFile with a timeout and SIGKILL, but does NOT put
//     the child in its own process group, so a wedged git can leave
//     descendants running.
//   - agent-runner.ts does spawn detached and kills with process.kill(-pid),
//     but marks the run finished BEFORE the process exits.
// The publication lock is released only after the promise here settles, so
// "resolves only on confirmed exit" is the whole point of this file.

import { spawn } from 'node:child_process'

/** An editor or credential prompt with no TTY hangs until the timeout, which
 *  is precisely the lost-lock failure this design is built to avoid. */
export const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  GIT_PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1'
} as const

export interface SuperviseOptions {
  cwd: string
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number
  env?: Record<string, string>
}

export interface SupervisedResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The child's pid, which is also its process-group id (detached: true). */
  pid: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_GRACE_MS = 3_000
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

export function runSupervised(
  command: string,
  args: string[],
  options: SuperviseOptions
): Promise<SupervisedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS

  return new Promise<SupervisedResult>((resolve) => {
    // detached: true gives the child its own process group whose pgid is its
    // pid, so process.kill(-pid) reaches every descendant it spawned.
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const pid = child.pid ?? -1
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const capture = (current: string, chunk: Buffer): string =>
      current.length >= MAX_CAPTURE_BYTES ? current : current + chunk.toString('utf8')

    child.stdout?.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk) })

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pid <= 0) return
      try {
        process.kill(-pid, signal)
      } catch {
        // The group may already be gone, or the platform may not support it.
        try { child.kill(signal) } catch { /* already exited */ }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
    }, timeoutMs)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, stdout, stderr, timedOut, pid })
    }

    child.on('error', (error: Error) => {
      stderr += String(error.message)
      finish(null)
    })

    // 'close' fires after the process has exited AND its stdio has closed.
    // 'exit' would fire first and is not proof the descendants are reaped.
    child.on('close', (code) => finish(code))
  })
}

export function runGit(args: string[], options: SuperviseOptions): Promise<SupervisedResult> {
  return runSupervised('git', args, {
    ...options,
    timeoutMs: options.timeoutMs ?? 30_000,
    env: { ...NON_INTERACTIVE_GIT_ENV, ...(options.env ?? {}) }
  })
}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/supervise.test.ts`
Expected: PASS — 7 tests.

- [x] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 with no output.

- [x] **Step 7: Commit**

```bash
git add src/shared/conductor.ts src/main/supervise.ts test/supervise.test.ts
git commit -m "feat(conductor): add Phase 1 types and a reap-before-release process supervisor"
```

---

### Task 2: Lane manager — create, facts, destroy

**Files:**
- Create: `src/main/lanes.ts`
- Test: `test/lanes-lifecycle.test.ts`

**Interfaces:**
- Consumes: `runGit` from `src/main/supervise.ts`; `ConductorLane`, `ConductorSettings`, `LaneFacts`, `MergeResult`, `PublishResult` from `src/shared/conductor.ts`.
- Produces: `createLaneManager(settings: ConductorSettings): LaneManager` and the `LaneManager` interface from `src/main/lanes.ts`. Methods added in this task: `ensureIntegrationWorktree()`, `create(name, agent)`, `facts(lane)`, `destroy(lane, { force })`.

- [ ] **Step 1: Write the failing test**

Create `test/lanes-lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e' }
  }).trim()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-lanes-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'base'], repo)
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

describe('lane manager lifecycle', () => {
  it('creates an integration worktree whose HEAD is detached', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    expect(existsSync(settings.integrationWorktree)).toBe(true)
    // If HEAD sat on integrationBranch, update-ref would advance the ref and
    // leave this worktree's index behind it.
    expect(() => git(['symbolic-ref', 'HEAD'], settings.integrationWorktree)).toThrow()
    expect(git(['rev-parse', 'HEAD'], settings.integrationWorktree))
      .toBe(git(['rev-parse', 'crew/integration'], settings.repo))
  })

  it('leaves the integration branch checked out nowhere', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const list = git(['worktree', 'list', '--porcelain'], settings.repo)
    expect(list).not.toContain('branch refs/heads/crew/integration')
  })

  it('is idempotent when the integration worktree already exists', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    await expect(lanes.ensureIntegrationWorktree()).resolves.toBeUndefined()
  })

  it('creates a lane on its own branch, based on the integration branch', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'copilot-cli', model: 'claude-opus-5.5' })
    expect(lane.branch).toBe('crew/lane/builder')
    expect(existsSync(lane.worktree)).toBe(true)
    expect(lane.agent.model).toBe('claude-opus-5.5')
    expect(git(['rev-parse', lane.branch], settings.repo))
      .toBe(git(['rev-parse', 'crew/integration'], settings.repo))
  })

  it('reports ahead, behind and a clean tree for a fresh lane', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    const facts = await lanes.facts(lane)
    expect(facts).toMatchObject({ ahead: 0, behind: 0, dirtyTracked: false, untracked: false })
    expect(facts.laneTip).toBe(facts.baseSha)
  })

  it('counts ahead commits and does not confuse them with behind', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'a.txt'), 'one\n')
    git(['add', '.'], lane.worktree)
    git(['commit', '-m', 'lane work'], lane.worktree)
    const facts = await lanes.facts(lane)
    expect(facts.ahead).toBe(1)
    expect(facts.behind).toBe(0)
  })

  // The spec demotes dirty to advisory precisely so a lane cannot stall
  // forever on coverage/ or .DS_Store.
  it('separates tracked modifications from untracked files', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'scratch.txt'), 'notes\n')
    let facts = await lanes.facts(lane)
    expect(facts.untracked).toBe(true)
    expect(facts.dirtyTracked).toBe(false)

    writeFileSync(join(lane.worktree, 'README.md'), 'changed\n')
    facts = await lanes.facts(lane)
    expect(facts.dirtyTracked).toBe(true)
  })

  it('refuses to destroy a lane with uncommitted changes unless forced', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    writeFileSync(join(lane.worktree, 'README.md'), 'changed\n')
    await expect(lanes.destroy(lane, { force: false })).rejects.toThrow(/uncommitted/i)
    expect(existsSync(lane.worktree)).toBe(true)
    await lanes.destroy(lane, { force: true })
    expect(existsSync(lane.worktree)).toBe(false)
  })

  it('destroys a clean lane without force', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    await lanes.destroy(lane, { force: false })
    expect(existsSync(lane.worktree)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lanes-lifecycle.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/lanes"`.

- [ ] **Step 3: Write the lane manager**

Create `src/main/lanes.ts`:

```ts
// Every git invocation in the conductor lives here, behind a narrow interface,
// so the conductor runtime never shells out itself.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runGit } from './supervise'
import type {
  ConductorLane,
  ConductorSettings,
  LaneFacts,
  LaneAgent,
  MergeResult,
  PublishResult
} from '../shared/conductor'

export interface LaneManager {
  /** Create the Crew-owned integration worktree if absent. Always detached. */
  ensureIntegrationWorktree(): Promise<void>
  create(name: string, agent: LaneAgent): Promise<ConductorLane>
  facts(lane: ConductorLane): Promise<LaneFacts>
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

  const ensureIntegrationWorktree = async (): Promise<void> => {
    const list = await inRepo(['worktree', 'list', '--porcelain'])
    if (list.split('\n').some((line) => line === `worktree ${settings.integrationWorktree}`)) return
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
    return { id: randomUUID(), name, agent, worktree, branch, status: 'working' }
  }

  const facts = async (lane: ConductorLane): Promise<LaneFacts> => {
    const [counts, tracked, all, laneTip, baseSha] = await Promise.all([
      // left = on base not lane (behind), right = on lane not base (ahead).
      inRepo(['rev-list', '--left-right', '--count', `${settings.integrationBranch}...${lane.branch}`]),
      inDir(lane.worktree, ['status', '--porcelain', '--untracked-files=no']),
      inDir(lane.worktree, ['status', '--porcelain', '--untracked-files=normal']),
      inRepo(['rev-parse', lane.branch]),
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
  }

  return { ensureIntegrationWorktree, create, facts, destroy }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lanes-lifecycle.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/lanes.ts test/lanes-lifecycle.test.ts
git commit -m "feat(conductor): add lane manager create/facts/destroy on a detached integration worktree"
```

---

### Task 3: Lane manager — merge into integration, and sync a lane

**Files:**
- Modify: `src/main/lanes.ts` (add two methods to `LaneManager` and its factory)
- Test: `test/lanes-merge.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `mergeInIntegration(candidate: string, base: string): Promise<MergeResult>` and `syncLane(lane: ConductorLane, base: string): Promise<MergeResult>` on `LaneManager`.

- [ ] **Step 1: Write the failing test**

Create `test/lanes-merge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-merge-'))
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

describe('mergeInIntegration', () => {
  it('fast-forwards when the base is an ancestor of the candidate', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch], settings.repo)
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
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch], settings.repo),
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
    const first = await lanes.mergeInIntegration(git(['rev-parse', a.branch], settings.repo), base)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await lanes.mergeInIntegration(
      git(['rev-parse', b.branch], settings.repo),
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
    await lanes.mergeInIntegration(git(['rev-parse', lane.branch], settings.repo), base)
    expect(() => git(['symbolic-ref', 'HEAD'], settings.integrationWorktree)).toThrow()
  })
})

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
      git(['rev-parse', other.branch], settings.repo), base
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
      git(['rev-parse', other.branch], settings.repo), base
    )
    expect(merged.ok).toBe(true)
    if (!merged.ok) return
    git(['update-ref', 'refs/heads/crew/integration', merged.resultSha], settings.repo)

    const result = await lanes.syncLane(lane, merged.resultSha)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflictPaths).toContain('shared.txt')
    expect(git(['status', '--porcelain'], lane.worktree)).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lanes-merge.test.ts`
Expected: FAIL — `lanes.mergeInIntegration is not a function`.

- [ ] **Step 3: Extend the `LaneManager` interface**

In `src/main/lanes.ts`, add these two members to the `LaneManager` interface, immediately after `facts`:

```ts
  /** Merge the frozen candidate into the base, in the detached integration
   *  worktree. Never rebases: rewriting history strands the lane branch and
   *  makes every later publication replay its own already-landed commits. */
  mergeInIntegration(candidate: string, base: string): Promise<MergeResult>
  /** Bring the integration branch INTO a lane. The only way a lane receives
   *  its teammates' work. Runs only when the lane is quiescent. */
  syncLane(lane: ConductorLane, base: string): Promise<MergeResult>
```

- [ ] **Step 4: Implement the two merges**

In `src/main/lanes.ts`, add these functions inside `createLaneManager`, immediately before the `destroy` definition:

```ts
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
```

- [ ] **Step 5: Export the new methods**

In `src/main/lanes.ts`, change the factory's return statement to:

```ts
  return { ensureIntegrationWorktree, create, facts, mergeInIntegration, syncLane, destroy }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/lanes-merge.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 7: Commit**

```bash
git add src/main/lanes.ts test/lanes-merge.test.ts
git commit -m "feat(conductor): merge-based integration and an explicit lane sync"
```

---

### Task 4: Lane manager — publish by compare-and-swap

**Files:**
- Modify: `src/main/lanes.ts`
- Test: `test/lanes-publish.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: `publish(newSha: string, expectedOld: string): Promise<PublishResult>` on `LaneManager`.

- [ ] **Step 1: Write the failing test**

Create `test/lanes-publish.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import type { ConductorSettings, ConductorLane } from '../src/shared/conductor'

let root: string
let settings: ConductorSettings

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-publish-'))
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

/** Merge a lane's tip into the current integration ref and CAS it into place. */
async function publishLane(lanes: ReturnType<typeof createLaneManager>, lane: ConductorLane) {
  const base = git(['rev-parse', 'crew/integration'], settings.repo)
  const tip = git(['rev-parse', lane.branch], settings.repo)
  const merged = await lanes.mergeInIntegration(tip, base)
  if (!merged.ok) throw new Error(`merge failed: ${merged.message}`)
  return lanes.publish(merged.resultSha, base)
}

describe('publish', () => {
  it('advances the integration ref and reports the touched paths', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const result = await publishLane(lanes, lane)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.touchedPaths).toEqual(['a.txt'])
      expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(result.commit)
    }
  })

  // External mutation must stop and surface, never blind-retry.
  it('refuses when the ref has moved underneath it', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const stale = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, stale)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    // Someone else moves the branch between the merge and the CAS.
    commit(settings.repo, 'outside.txt', 'X\n', 'outside work')
    git(['update-ref', 'refs/heads/crew/integration', git(['rev-parse', 'HEAD'], settings.repo)], settings.repo)

    const result = await lanes.publish(merged.resultSha, stale)
    expect(result).toMatchObject({ ok: false, reason: 'ref-moved' })
  })

  // git only refuses a checkout when another worktree holds the branch as
  // HEAD, so this check is what keeps the user free to check it out themselves.
  it('refuses when a worktree has the integration branch checked out', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })
    commit(lane.worktree, 'a.txt', 'one\n', 'lane work')

    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    const tip = git(['rev-parse', lane.branch], settings.repo)
    const merged = await lanes.mergeInIntegration(tip, base)
    expect(merged.ok).toBe(true)
    if (!merged.ok) return

    git(['worktree', 'add', join(root, 'user-checkout'), 'crew/integration'], settings.repo)
    const result = await lanes.publish(merged.resultSha, base)
    expect(result).toMatchObject({ ok: false, reason: 'branch-checked-out' })
    expect(git(['rev-parse', 'crew/integration'], settings.repo)).toBe(base)
  })

  // THE REGRESSION TEST. Publishing by rebase left the lane branch pointing at
  // the original commits, so `ahead` never returned to 0 and the next
  // publication replayed the lane's own landed commits against themselves.
  it('lets one lane publish twice in a row, resetting ahead each time', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const lane = await lanes.create('builder', { presetId: 'shell', model: null })

    commit(lane.worktree, 'a.txt', 'one\n', 'first')
    expect((await lanes.facts(lane)).ahead).toBe(1)
    const first = await publishLane(lanes, lane)
    expect(first.ok).toBe(true)
    expect((await lanes.facts(lane)).ahead).toBe(0)

    commit(lane.worktree, 'a.txt', 'two\n', 'second')
    expect((await lanes.facts(lane)).ahead).toBe(1)
    const second = await publishLane(lanes, lane)
    expect(second.ok).toBe(true)
    expect((await lanes.facts(lane)).ahead).toBe(0)
    // Exactly the two lane commits landed, neither replayed.
    const log = git(['log', '--format=%s', 'crew/integration'], settings.repo).split('\n')
    expect(log.filter((s) => s === 'first')).toHaveLength(1)
    expect(log.filter((s) => s === 'second')).toHaveLength(1)
  })

  // The scenario the feature exists for, and the one rebase broke: two lanes
  // both landing, repeatedly.
  it('lets two lanes publish alternately without replaying each other', async () => {
    const lanes = createLaneManager(settings)
    await lanes.ensureIntegrationWorktree()
    const a = await lanes.create('a', { presetId: 'shell', model: null })
    const b = await lanes.create('b', { presetId: 'shell', model: null })

    commit(a.worktree, 'a.txt', 'A1\n', 'a1')
    expect((await publishLane(lanes, a)).ok).toBe(true)

    commit(b.worktree, 'b.txt', 'B1\n', 'b1')
    expect((await publishLane(lanes, b)).ok).toBe(true)

    // a must be able to sync and publish again with no conflict against itself.
    const base = git(['rev-parse', 'crew/integration'], settings.repo)
    expect((await lanes.syncLane(a, base)).ok).toBe(true)
    commit(a.worktree, 'a.txt', 'A2\n', 'a2')
    expect((await publishLane(lanes, a)).ok).toBe(true)

    const log = git(['log', '--format=%s', 'crew/integration'], settings.repo)
    for (const subject of ['a1', 'b1', 'a2']) {
      expect(log.split('\n').filter((s) => s === subject)).toHaveLength(1)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lanes-publish.test.ts`
Expected: FAIL — `lanes.publish is not a function`.

- [ ] **Step 3: Extend the `LaneManager` interface**

In `src/main/lanes.ts`, add to the `LaneManager` interface after `syncLane`:

```ts
  /** Compare-and-swap the integration ref. Refuses if any worktree has the
   *  branch checked out. */
  publish(newSha: string, expectedOld: string): Promise<PublishResult>
```

- [ ] **Step 4: Implement `publish`**

In `src/main/lanes.ts`, add inside `createLaneManager`, immediately before `destroy`:

```ts
  const branchIsCheckedOut = async (): Promise<boolean> => {
    const list = await inRepo(['worktree', 'list', '--porcelain'])
    return list.split('\n').some((line) => line.trim() === `branch refs/heads/${settings.integrationBranch}`)
  }

  const publish = async (newSha: string, expectedOld: string): Promise<PublishResult> => {
    // Step 7 of the publication transaction, immediately before the CAS:
    // update-ref on a branch that is somebody's HEAD advances the ref and
    // leaves their index and files behind it.
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

    const diff = await inRepo(['diff', '--name-only', expectedOld, newSha])
    return {
      ok: true,
      commit: newSha,
      touchedPaths: diff.split('\n').map((line) => line.trim()).filter(Boolean)
    }
  }
```

- [ ] **Step 5: Export it**

In `src/main/lanes.ts`, change the factory's return statement to:

```ts
  return {
    ensureIntegrationWorktree, create, facts,
    mergeInIntegration, syncLane, publish, destroy
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/lanes-publish.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 7: Run the whole lane suite and typecheck**

Run: `npx vitest run test/lanes-lifecycle.test.ts test/lanes-merge.test.ts test/lanes-publish.test.ts && npm run typecheck`
Expected: 20 tests pass; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/main/lanes.ts test/lanes-publish.test.ts
git commit -m "feat(conductor): publish by ref compare-and-swap, refusing a checked-out branch"
```

---

### Task 5: The two-write, fail-closed journal

**Files:**
- Create: `src/main/conductor-journal.ts`
- Test: `test/conductor-journal.test.ts`

**Interfaces:**
- Consumes: `atomicWriteFile`, `AtomicWriteError` from `src/main/atomic-file.ts`.
- Produces: `JournalPhase`, `JournalEntry`, `createJournal(path: string): Journal` with `append(entry)`, `read()`, `entriesFor(opId)` from `src/main/conductor-journal.ts`.

**Why its own file:** `store.ts` quarantines the *entire* store on corruption. A per-effect append is the most frequently written and most corruption-exposed data in this feature, and a damaged journal must not cost the user their session roster.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-journal.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal, JOURNAL_MAX_ENTRIES } from '../src/main/conductor-journal'

let root: string
let path: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-journal-'))
  path = join(root, 'conductor-journal.json')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const intent = (opId: string) => ({
  opId, laneId: 'lane-1', phase: 'intent' as const,
  baseSha: 'aaa', laneTip: 'bbb', at: 1
})

describe('journal', () => {
  it('reads empty when the file does not exist', () => {
    expect(createJournal(path).read()).toEqual([])
  })

  it('appends and reads back in order', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', at: 2 })
    const entries = journal.read()
    expect(entries.map((e) => e.phase)).toEqual(['intent', 'merged'])
    expect(entries[1].resultSha).toBe('ccc')
  })

  // The resulting SHA does not exist until the merge has run, so one write
  // leaves "committed but unrecorded" unclassifiable.
  it('records intent and result as two separate entries for one operation', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', at: 2 })
    journal.append(intent('op-2'))
    const forOp = journal.entriesFor('op-1')
    expect(forOp).toHaveLength(2)
    expect(forOp.every((e) => e.opId === 'op-1')).toBe(true)
  })

  it('survives a new instance reading the same file', () => {
    createJournal(path).append(intent('op-1'))
    expect(createJournal(path).read()).toHaveLength(1)
  })

  it('bounds the file, discarding the oldest entries', () => {
    const journal = createJournal(path)
    for (let i = 0; i < JOURNAL_MAX_ENTRIES + 25; i += 1) {
      journal.append({ ...intent(`op-${i}`), at: i })
    }
    const entries = journal.read()
    expect(entries).toHaveLength(JOURNAL_MAX_ENTRIES)
    expect(entries[0].opId).toBe('op-25')
  })

  // A damaged journal must not cost the user anything else, and must not be
  // silently treated as "nothing happened" — that would classify an
  // interrupted publication as not-started and double-apply it.
  it('throws on a corrupt journal rather than reporting an empty one', () => {
    writeFileSync(path, '{not json')
    expect(() => createJournal(path).read()).toThrow(/corrupt/i)
  })

  // Persistence failure must fail closed and prevent the effect, rather than
  // reporting success from memory as the store's best-effort save does.
  it('throws when the write fails, so the caller aborts the effect', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    chmodSync(root, 0o500)
    try {
      expect(() => journal.append(intent('op-2'))).toThrow()
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('writes valid JSON a human can read during an incident', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-journal.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/conductor-journal"`.

- [ ] **Step 3: Write the journal**

Create `src/main/conductor-journal.ts`:

```ts
// The publication journal. Deliberately NOT part of the store: store.ts
// quarantines the whole file on corruption, and this is the most frequently
// written and most corruption-exposed data in the feature. A damaged journal
// must not cost the user their session roster.

import { readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-file'

export type JournalPhase =
  | 'intent'      // written before anything runs
  | 'merged'      // written after the merge produces a commit, before the CAS
  | 'tests'       // written when the test phase starts
  | 'published'   // written after the CAS succeeds, before any dependent effect
  | 'notified'    // written after teammates are told
  | 'aborted'     // written when the operation gave up cleanly

export interface JournalEntry {
  opId: string
  laneId: string
  phase: JournalPhase
  baseSha: string
  laneTip: string
  /** Only knowable after the merge has run. Absent on 'intent'. */
  resultSha?: string
  /** Free-text reason, for 'aborted'. */
  detail?: string
  at: number
}

export const JOURNAL_MAX_ENTRIES = 500

export interface Journal {
  append(entry: JournalEntry): void
  read(): JournalEntry[]
  entriesFor(opId: string): JournalEntry[]
}

class JournalCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`conductor journal at ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'JournalCorruptError'
  }
}

export function createJournal(path: string): Journal {
  const read = (): JournalEntry[] => {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Never degrade to []: an unreadable journal looks identical to "nothing
      // happened", which would classify an interrupted publication as
      // not-started and double-apply the work.
      throw new JournalCorruptError(path, error)
    }
    if (!Array.isArray(parsed)) throw new JournalCorruptError(path, 'expected an array')
    return parsed as JournalEntry[]
  }

  const append = (entry: JournalEntry): void => {
    const entries = read()
    entries.push(entry)
    const bounded = entries.length > JOURNAL_MAX_ENTRIES
      ? entries.slice(entries.length - JOURNAL_MAX_ENTRIES)
      : entries
    mkdirSync(dirname(path), { recursive: true })
    // Throws on failure by design. The caller must abort the effect rather
    // than proceed with an unrecorded mutation of a shared ref.
    atomicWriteFile(path, JSON.stringify(bounded, null, 2))
  }

  const entriesFor = (opId: string): JournalEntry[] => read().filter((e) => e.opId === opId)

  return { append, read, entriesFor }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conductor-journal.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/conductor-journal.ts test/conductor-journal.test.ts
git commit -m "feat(conductor): add a bounded, fail-closed publication journal"
```

---

### Task 6: The crash classifier

**Files:**
- Create: `src/shared/conductor-recovery.ts`
- Test: `test/conductor-recovery.test.ts`

**Interfaces:**
- Consumes: `JournalEntry`, `JournalPhase` — re-declared structurally here so `shared/` never imports from `main/`.
- Produces: `Classification`, `OperationReality`, `classifyOperation(entries, reality)`, `RECOVERY_ACTIONS` from `src/shared/conductor-recovery.ts`.

**Why pure:** this table is the difference between a clean restart and double-applying work to a shared branch. It must be exhaustively testable without a repo, a clock, or Electron.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-recovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  classifyOperation,
  RECOVERY_ACTIONS,
  type OperationReality
} from '../src/shared/conductor-recovery'
import type { JournalEntry } from '../src/main/conductor-journal'

const BASE = 'base-sha'
const RESULT = 'result-sha'

const entry = (phase: JournalEntry['phase'], extra: Partial<JournalEntry> = {}): JournalEntry => ({
  opId: 'op-1', laneId: 'lane-1', phase, baseSha: BASE, laneTip: 'tip', at: 1, ...extra
})

const reality = (over: Partial<OperationReality> = {}): OperationReality => ({
  refSha: BASE, mergeHeadPresent: false, integrationDirty: false, ...over
})

describe('classifyOperation', () => {
  it('classifies intent with untouched refs as not-started', () => {
    expect(classifyOperation([entry('intent')], reality())).toBe('not-started')
  })

  it('classifies a present MERGE_HEAD as an interrupted merge', () => {
    expect(classifyOperation([entry('intent')], reality({ mergeHeadPresent: true })))
      .toBe('interrupted-merge')
  })

  it('classifies a recorded result with an unmoved ref as merged-unpublished', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality())).toBe('merged-unpublished')
  })

  // The single most dangerous state: redoing it double-applies the work.
  it('classifies a ref equal to the result with no published entry as published-unrecorded', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('published-unrecorded')
  })

  it('classifies a published operation with no notification as published-unnotified', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('published-unnotified')
  })

  it('classifies a fully journalled operation as complete', () => {
    const entries = [
      entry('intent'),
      entry('merged', { resultSha: RESULT }),
      entry('published', { resultSha: RESULT }),
      entry('notified', { resultSha: RESULT })
    ]
    expect(classifyOperation(entries, reality({ refSha: RESULT }))).toBe('complete')
  })

  it('classifies a ref matching neither base nor result as externally-modified', () => {
    const entries = [entry('intent'), entry('merged', { resultSha: RESULT })]
    expect(classifyOperation(entries, reality({ refSha: 'someone-elses-sha' })))
      .toBe('externally-modified')
  })

  it('classifies a moved ref with no result recorded as externally-modified', () => {
    expect(classifyOperation([entry('intent')], reality({ refSha: 'elsewhere' })))
      .toBe('externally-modified')
  })

  it('classifies a dirty integration worktree mid-tests as interrupted-tests', () => {
    const entries = [entry('intent'), entry('tests')]
    expect(classifyOperation(entries, reality({ integrationDirty: true })))
      .toBe('interrupted-tests')
  })

  it('treats an aborted operation as complete, needing no recovery', () => {
    const entries = [entry('intent'), entry('aborted', { detail: 'conflict' })]
    expect(classifyOperation(entries, reality())).toBe('complete')
  })

  it('classifies an empty journal as complete', () => {
    expect(classifyOperation([], reality())).toBe('complete')
  })

  // A merge is interrupted, not restartable-in-place: silently restarting
  // could discard a half-resolved index.
  it('never offers a silent redo for an interrupted merge', () => {
    expect(RECOVERY_ACTIONS['interrupted-merge'].safeToRedo).toBe(false)
    expect(RECOVERY_ACTIONS['interrupted-merge'].requiresHuman).toBe(true)
  })

  it('never republishes a published-unrecorded operation', () => {
    expect(RECOVERY_ACTIONS['published-unrecorded'].safeToRedo).toBe(false)
  })

  it('requires a human for external modification', () => {
    expect(RECOVERY_ACTIONS['externally-modified'].requiresHuman).toBe(true)
  })

  it('describes every classification', () => {
    const all: Array<keyof typeof RECOVERY_ACTIONS> = [
      'not-started', 'interrupted-merge', 'merged-unpublished', 'published-unrecorded',
      'published-unnotified', 'externally-modified', 'interrupted-tests', 'complete'
    ]
    for (const key of all) {
      expect(RECOVERY_ACTIONS[key].summary.length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-recovery.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/conductor-recovery"`.

- [ ] **Step 3: Write the classifier**

Create `src/shared/conductor-recovery.ts`:

```ts
// Pure reconciliation. `finally` does not run when the process is killed, and
// Electron apps get quit, so every crash point must be classifiable from the
// journal plus what is actually on disk. No IO here on purpose: this table is
// the difference between a clean restart and double-applying work to a shared
// branch, and it must be exhaustively testable.

/** Structural shape of a journal entry. Declared here rather than imported so
 *  shared/ never depends on main/. */
export interface RecoveryJournalEntry {
  opId: string
  laneId: string
  phase: 'intent' | 'merged' | 'tests' | 'published' | 'notified' | 'aborted'
  baseSha: string
  laneTip: string
  resultSha?: string
  detail?: string
  at: number
}

export interface OperationReality {
  /** What integrationBranch actually points at right now. */
  refSha: string
  /** MERGE_HEAD present in the integration worktree. */
  mergeHeadPresent: boolean
  /** The integration worktree has modifications. */
  integrationDirty: boolean
}

export type Classification =
  | 'not-started'
  | 'interrupted-merge'
  | 'merged-unpublished'
  | 'published-unrecorded'
  | 'published-unnotified'
  | 'externally-modified'
  | 'interrupted-tests'
  | 'complete'

export interface RecoveryAction {
  summary: string
  /** Whether redoing the operation from the start is safe. */
  safeToRedo: boolean
  /** Whether the user must choose before anything runs. */
  requiresHuman: boolean
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
    summary: 'The branch already moved. Record it and notify — never republish.',
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

export function classifyOperation(
  entries: readonly RecoveryJournalEntry[],
  reality: OperationReality
): Classification {
  if (entries.length === 0) return 'complete'

  const phases = new Set(entries.map((e) => e.phase))
  if (phases.has('aborted')) return 'complete'
  if (phases.has('notified')) return 'complete'

  const baseSha = entries[0].baseSha
  const resultSha = entries.find((e) => e.resultSha)?.resultSha

  if (resultSha) {
    if (reality.refSha === resultSha) {
      return phases.has('published') ? 'published-unnotified' : 'published-unrecorded'
    }
    if (reality.refSha === baseSha) return 'merged-unpublished'
    return 'externally-modified'
  }

  // No result recorded: the merge never produced a commit we know about.
  if (reality.refSha !== baseSha) return 'externally-modified'
  if (reality.mergeHeadPresent) return 'interrupted-merge'
  if (phases.has('tests') && reality.integrationDirty) return 'interrupted-tests'
  if (reality.integrationDirty) return 'interrupted-tests'
  return 'not-started'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conductor-recovery.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/conductor-recovery.ts test/conductor-recovery.test.ts
git commit -m "feat(conductor): classify every publication crash point from journal and disk"
```

---

### Task 7: Exclusivity — a lane belongs to at most one conducted workspace

**Files:**
- Create: `src/shared/conductor-membership.ts`
- Test: `test/conductor-membership.test.ts`

**Interfaces:**
- Consumes: nothing (accepts structural inputs).
- Produces: `MembershipWorkspace`, `MembershipSession`, `Conflict`, `canConduct(workspaces, sessions, wsId)`, `validateMembershipChange(...)` from `src/shared/conductor-membership.ts`.

**Why this is data, not a UI consequence:** `activeWorkspace` is a *per-window* view preference (`readViewPref`, namespaced by window slot in `window-scope.ts`), so two windows can have two workspaces active at once — and conducting must survive switching away. "Active" (view) and "conducting" (runtime) are decoupled.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-membership.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  canConduct,
  validateMembershipChange,
  type MembershipSession,
  type MembershipWorkspace
} from '../src/shared/conductor-membership'

const ws = (id: string, conducted = false): MembershipWorkspace => ({ id, name: id, conducted })
const s = (id: string, workspaceIds: string[]): MembershipSession => ({ id, label: id, workspaceIds })

describe('canConduct', () => {
  it('allows conducting a workspace whose sessions are in no other conducted workspace', () => {
    const result = canConduct([ws('a'), ws('b')], [s('s1', ['a']), s('s2', ['a', 'b'])], 'a')
    expect(result.ok).toBe(true)
  })

  it('rejects when a member session is already in a conducted workspace', () => {
    const result = canConduct([ws('a'), ws('b', true)], [s('s1', ['a', 'b'])], 'a')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toMatchObject({ sessionId: 's1', otherWorkspaceId: 'b' })
    }
  })

  it('names every conflicting session, not just the first', () => {
    const result = canConduct(
      [ws('a'), ws('b', true)],
      [s('s1', ['a', 'b']), s('s2', ['a', 'b']), s('s3', ['a'])],
      'a'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts.map((c) => c.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('ignores the workspace being tested when it is already conducted', () => {
    expect(canConduct([ws('a', true)], [s('s1', ['a'])], 'a').ok).toBe(true)
  })

  it('is unaffected by which workspace is active in which window', () => {
    // There is no active-workspace input by design: exclusivity is enforced on
    // membership data, never on a per-window view preference.
    const result = canConduct([ws('a'), ws('b', true)], [s('s1', ['b'])], 'a')
    expect(result.ok).toBe(true)
  })

  it('treats a session with no workspaces as no obstacle', () => {
    expect(canConduct([ws('a')], [s('s1', [])], 'a').ok).toBe(true)
  })

  it('fails closed on an unknown workspace id', () => {
    const result = canConduct([ws('a')], [s('s1', ['a'])], 'missing')
    expect(result.ok).toBe(false)
  })
})

describe('validateMembershipChange', () => {
  // Enforcement must cover EVERY membership mutation path, not only the toggle.
  it('rejects adding a session to a conducted workspace when it is in another', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', ['b'])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(false)
  })

  it('allows adding a session to a conducted workspace when it is in no other', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b')],
      [s('s1', ['b'])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(true)
  })

  it('always allows removing a session from a workspace', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', ['a'])],
      { sessionId: 's1', nextWorkspaceIds: [] }
    )
    expect(result.ok).toBe(true)
  })

  it('allows membership in many unconducted workspaces at once', () => {
    const result = validateMembershipChange(
      [ws('a'), ws('b'), ws('c')],
      [s('s1', [])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b', 'c'] }
    )
    expect(result.ok).toBe(true)
  })

  it('rejects membership in two conducted workspaces at once', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', [])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts[0].sessionId).toBe('s1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-membership.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/conductor-membership"`.

- [ ] **Step 3: Write the validator**

Create `src/shared/conductor-membership.ts`:

```ts
// A lane session belongs to at most ONE conducted workspace.
//
// The "only one workspace is open at a time" intuition does not hold:
// activeWorkspace is a per-window view preference (readViewPref, namespaced by
// window slot in window-scope.ts), so two windows can have two workspaces
// active at once, and conducting must survive switching away. "Active" (view)
// and "conducting" (runtime) are therefore decoupled, and exclusivity is
// enforced here, on membership data.

export interface MembershipWorkspace {
  id: string
  name: string
  conducted?: boolean
}

export interface MembershipSession {
  id: string
  label: string
  workspaceIds?: string[]
}

export interface Conflict {
  sessionId: string
  sessionLabel: string
  otherWorkspaceId: string
  otherWorkspaceName: string
}

export type MembershipVerdict =
  | { ok: true }
  | { ok: false; conflicts: Conflict[] }

function conductedById(
  workspaces: readonly MembershipWorkspace[]
): Map<string, MembershipWorkspace> {
  return new Map(workspaces.filter((w) => w.conducted).map((w) => [w.id, w]))
}

/** May `wsId` be conducted, given who its sessions already answer to? */
export function canConduct(
  workspaces: readonly MembershipWorkspace[],
  sessions: readonly MembershipSession[],
  wsId: string
): MembershipVerdict {
  const target = workspaces.find((w) => w.id === wsId)
  // Fail closed: an unknown workspace must never be conducted by default.
  if (!target) {
    return { ok: false, conflicts: [] }
  }
  const conducted = conductedById(workspaces)
  const conflicts: Conflict[] = []

  for (const session of sessions) {
    const ids = session.workspaceIds ?? []
    if (!ids.includes(wsId)) continue
    for (const id of ids) {
      if (id === wsId) continue
      const other = conducted.get(id)
      if (!other) continue
      conflicts.push({
        sessionId: session.id,
        sessionLabel: session.label,
        otherWorkspaceId: other.id,
        otherWorkspaceName: other.name
      })
    }
  }

  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts }
}

/** The single validator every membership mutation path must go through —
 *  set, add, remove, move and archive alike, not only the conducted toggle. */
export function validateMembershipChange(
  workspaces: readonly MembershipWorkspace[],
  sessions: readonly MembershipSession[],
  change: { sessionId: string; nextWorkspaceIds: string[] }
): MembershipVerdict {
  const conducted = conductedById(workspaces)
  const session = sessions.find((s) => s.id === change.sessionId)
  const label = session?.label ?? change.sessionId

  const conductedTargets = change.nextWorkspaceIds
    .map((id) => conducted.get(id))
    .filter((w): w is MembershipWorkspace => Boolean(w))

  if (conductedTargets.length <= 1) return { ok: true }

  // Report every workspace past the first as a conflict against it, so the UI
  // can name both sides of the collision.
  const [first, ...rest] = conductedTargets
  return {
    ok: false,
    conflicts: rest.map((other) => ({
      sessionId: change.sessionId,
      sessionLabel: label,
      otherWorkspaceId: other.id,
      otherWorkspaceName: other.name
    })).concat({
      sessionId: change.sessionId,
      sessionLabel: label,
      otherWorkspaceId: first.id,
      otherWorkspaceName: first.name
    }).slice(0, rest.length)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conductor-membership.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/conductor-membership.ts test/conductor-membership.test.ts
git commit -m "feat(conductor): enforce single-conducted-workspace exclusivity on membership data"
```

---

### Task 8: The conductor runtime — single-flight lock and the publication transaction

**Files:**
- Create: `src/main/conductor.ts`
- Test: `test/conductor-runtime.test.ts`

**Interfaces:**
- Consumes: `LaneManager` from `src/main/lanes.ts`; `Journal`, `JournalEntry` from `src/main/conductor-journal.ts`; `classifyOperation`, `Classification` from `src/shared/conductor-recovery.ts`; `runSupervised` from `src/main/supervise.ts`; `ConductorSettings`, `ConductorLane`, `TestRecipe` from `src/shared/conductor.ts`.
- Produces: `createConductor(deps: ConductorDeps): Conductor` with `publishLane(lane)`, `syncLane(lane)`, `isPublishing()`, `reconcile()`; plus the `PublishOutcome`, `SyncOutcome`, `ReconcileReport` and `ConductorDeps` types, from `src/main/conductor.ts`.

**The lock rule that shapes this file:** the lock is taken **synchronously, before any `await`**. Main-thread JavaScript does not serialise across `await`, so two events can both observe `publishing === null` and both act. And it is released only after the lane manager's promise has settled — every lane-manager call bottoms out in `runSupervised`, which resolves on `close`, i.e. confirmed child exit.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-runtime.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import { createJournal } from '../src/main/conductor-journal'
import { createConductor } from '../src/main/conductor'
import type { ConductorSettings, ConductorLane } from '../src/shared/conductor'

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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-runtime.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/conductor"`.

- [ ] **Step 3: Write the runtime**

Create `src/main/conductor.ts`:

```ts
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
import { classifyOperation, RECOVERY_ACTIONS } from '../shared/conductor-recovery'
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
      const classification = classifyOperation(group, reality)
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conductor-runtime.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Run the whole conductor suite and typecheck**

Run: `npx vitest run test/supervise.test.ts test/lanes-lifecycle.test.ts test/lanes-merge.test.ts test/lanes-publish.test.ts test/conductor-journal.test.ts test/conductor-recovery.test.ts test/conductor-membership.test.ts test/conductor-runtime.test.ts && npm run typecheck`
Expected: 79 tests pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/main/conductor.ts test/conductor-runtime.test.ts
git commit -m "feat(conductor): single-flight publication transaction with journalled recovery"
```

---

### Task 9: IPC surface — channels, a registrable handler module, preload and the typed API

**Files:**
- Create: `src/main/conductor-ipc.ts`
- Modify: `src/shared/types.ts` (the `IPC` object), `src/preload/index.ts`, `src/shared/api.ts`, `src/main/index.ts`
- Test: `test/conductor-ipc.test.ts`

**Interfaces:**
- Consumes: `Conductor` from `src/main/conductor.ts`; `LaneManager` from `src/main/lanes.ts`.
- Produces: `registerConductorIpc(ipc, backend, broadcast)` and the `ConductorBackend` interface from `src/main/conductor-ipc.ts`; the IPC payload types (`ConductorSnapshot`, `LaneCreateRequest`, `PublishOutcome`, `SyncOutcome`, `ReconcileReport`) are declared in `src/shared/conductor.ts`, not here; seven `CONDUCTOR_*` channels plus `EVT_CONDUCTOR_STATE` on the `IPC` object; six methods on `CrewAPI`.

**Follow the existing pattern, do not inline this into `index.ts`.** `src/main/custom-view-ipc.ts` already establishes it: a standalone module taking a structurally-typed `{ handle }` and a `broadcast` callback, so the whole surface is testable under `environment: 'node'` without Electron. `index.ts` only calls the register function.

The typed renderer surface is **`CrewAPI` in `src/shared/api.ts`** — `src/shared/global.d.ts` merely declares `window.crew: CrewAPI` and needs no edit.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-ipc.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC } from '../src/shared/types'
import { registerConductorIpc, type ConductorBackend } from '../src/main/conductor-ipc'
import type { ConductorLane } from '../src/shared/conductor'

type Handler = Parameters<IpcMain['handle']>[1]

function lane(overrides: Partial<ConductorLane> = {}): ConductorLane {
  return {
    id: 'lane-1',
    roleId: 'builder',
    kind: 'author',
    branch: 'crew/lane/builder',
    worktree: '/tmp/lanes/builder',
    sessionId: null,
    agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' },
    status: 'working',
    blockedReason: undefined,
    dispatches: 0,
    ...overrides
  }
}

function harness(backend: Partial<ConductorBackend> = {}) {
  const handlers = new Map<string, Handler>()
  const broadcast = vi.fn()
  const full: ConductorBackend = {
    state: vi.fn(async () => ({
      enabled: true,
      publishing: null,
      lanes: [lane()],
      facts: {},
      needsAttention: false
    })),
    createLane: vi.fn(async () => lane({ id: 'lane-2' })),
    destroyLane: vi.fn(async () => undefined),
    publishLane: vi.fn(async () => ({ ok: true as const, commit: 'abc', touchedPaths: [], warnings: [] })),
    syncLane: vi.fn(async () => ({ ok: true as const, resultSha: 'def', fastForward: true })),
    reconcile: vi.fn(async () => ({ needsAttention: false, operations: [] })),
    ...backend
  }
  registerConductorIpc({ handle: (channel, handler) => void handlers.set(channel, handler) }, full, broadcast)
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return Promise.resolve().then(() => handler({} as IpcMainInvokeEvent, ...args))
  }
  return { broadcast, handlers, invoke, backend: full }
}

describe('conductor IPC contract', () => {
  it('registers every conductor channel', () => {
    const { handlers } = harness()
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC.CONDUCTOR_STATE,
        IPC.CONDUCTOR_LANE_CREATE,
        IPC.CONDUCTOR_LANE_DESTROY,
        IPC.CONDUCTOR_PUBLISH,
        IPC.CONDUCTOR_SYNC,
        IPC.CONDUCTOR_RECONCILE
      ].sort()
    )
  })

  it('returns state without broadcasting, because reads are not changes', async () => {
    const { invoke, broadcast } = harness()
    const state = await invoke(IPC.CONDUCTOR_STATE)
    expect(state).toMatchObject({ enabled: true, publishing: null })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('broadcasts fresh state after a successful publication', async () => {
    const { invoke, broadcast } = harness()
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: true, commit: 'abc' })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast.mock.calls[0][0]).toBe(IPC.EVT_CONDUCTOR_STATE)
  })

  // A rejected publication still changes what the user should see: the lane
  // is now blocked. Broadcasting only on success would strand that in the UI.
  it('broadcasts fresh state after a rejected publication too', async () => {
    const { invoke, broadcast } = harness({
      publishLane: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const, conflictPaths: ['a.txt'], message: 'conflict' }))
    })
    const outcome = await invoke(IPC.CONDUCTOR_PUBLISH, 'lane-1')
    expect(outcome).toMatchObject({ ok: false, reason: 'conflict' })
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('does not broadcast when a handler throws', async () => {
    const { invoke, broadcast } = harness({
      createLane: vi.fn(async () => { throw new Error('lane limit reached') })
    })
    await expect(invoke(IPC.CONDUCTOR_LANE_CREATE, { roleId: 'builder', agent: { presetId: 'shell', model: null } }))
      .rejects.toThrow('lane limit reached')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('passes lane creation arguments through unchanged', async () => {
    const { invoke, backend } = harness()
    const request = { roleId: 'reviewer', agent: { presetId: 'copilot-cli', model: 'claude-opus-5' } }
    await invoke(IPC.CONDUCTOR_LANE_CREATE, request)
    expect(backend.createLane).toHaveBeenCalledWith(request)
  })

  it('exposes every conductor channel through the preload bridge', () => {
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
    for (const key of [
      'CONDUCTOR_STATE', 'CONDUCTOR_LANE_CREATE', 'CONDUCTOR_LANE_DESTROY',
      'CONDUCTOR_PUBLISH', 'CONDUCTOR_SYNC', 'CONDUCTOR_RECONCILE',
      'EVT_CONDUCTOR_STATE'
    ]) {
      expect(preload).toContain(`IPC.${key}`)
    }
  })

  it('registers the conductor IPC module from the main entrypoint', () => {
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('registerConductorIpc')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-ipc.test.ts`
Expected: FAIL — `Failed to resolve import "../src/main/conductor-ipc"`.

- [ ] **Step 3: Add the channels**

In `src/shared/types.ts`, inside the `IPC` object, after the custom-view channels:

```ts
  CONDUCTOR_STATE: 'conductor:state',
  CONDUCTOR_LANE_CREATE: 'conductor:laneCreate',
  CONDUCTOR_LANE_DESTROY: 'conductor:laneDestroy',
  CONDUCTOR_PUBLISH: 'conductor:publish',
  CONDUCTOR_SYNC: 'conductor:sync',
  CONDUCTOR_RECONCILE: 'conductor:reconcile',
```

and with the other `EVT_` channels:

```ts
  EVT_CONDUCTOR_STATE: 'evt:conductorState',
```

- [ ] **Step 4: Write the handler module**

Create `src/main/conductor-ipc.ts`:

```ts
// Conductor IPC. A standalone registrable module, following custom-view-ipc.ts,
// so the whole surface is testable without Electron.

import { IPC } from '../shared/types'
import type {
  ConductorSnapshot,
  LaneCreateRequest,
  ConductorLane,
  PublishOutcome,
  SyncOutcome,
  ReconcileReport
} from '../shared/conductor'

// ConductorSnapshot and LaneCreateRequest are declared in src/shared/conductor.ts
// (Task 1) because the renderer reads them.

export interface ConductorBackend {
  state(): Promise<ConductorSnapshot>
  createLane(request: LaneCreateRequest): Promise<ConductorLane>
  destroyLane(laneId: string): Promise<void>
  publishLane(laneId: string): Promise<PublishOutcome>
  syncLane(laneId: string): Promise<SyncOutcome>
  reconcile(): Promise<ReconcileReport>
}

interface IpcLike {
  handle(channel: string, handler: (event: never, ...args: never[]) => unknown): void
}

type Broadcast = (channel: string, payload: unknown) => void

export function registerConductorIpc(
  ipc: IpcLike,
  backend: ConductorBackend,
  broadcast: Broadcast
): void {
  const publishState = async (): Promise<void> => {
    broadcast(IPC.EVT_CONDUCTOR_STATE, await backend.state())
  }

  ipc.handle(IPC.CONDUCTOR_STATE, () => backend.state())

  // Every mutating handler re-broadcasts, including on a rejected outcome: a
  // rejection still changes what the user should see (the lane is now blocked).
  // A thrown handler broadcasts nothing, because nothing is known to have
  // changed and the renderer would be told a lie.
  ipc.handle(IPC.CONDUCTOR_LANE_CREATE, async (_e, request: LaneCreateRequest) => {
    const lane = await backend.createLane(request)
    await publishState()
    return lane
  })

  ipc.handle(IPC.CONDUCTOR_LANE_DESTROY, async (_e, laneId: string) => {
    await backend.destroyLane(laneId)
    await publishState()
  })

  ipc.handle(IPC.CONDUCTOR_PUBLISH, async (_e, laneId: string) => {
    const outcome = await backend.publishLane(laneId)
    await publishState()
    return outcome
  })

  ipc.handle(IPC.CONDUCTOR_SYNC, async (_e, laneId: string) => {
    const outcome = await backend.syncLane(laneId)
    await publishState()
    return outcome
  })

  ipc.handle(IPC.CONDUCTOR_RECONCILE, () => backend.reconcile())
}
```

Note the casts needed to satisfy `IpcLike`'s `never` parameters are handled by declaring each handler's own parameter types; if TypeScript complains, widen `IpcLike.handle` to `(channel: string, handler: (event: any, ...args: any[]) => unknown) => void` exactly as `custom-view-ipc.ts` does — match that file rather than inventing a different shape.

- [ ] **Step 5: Extend the renderer API**

In `src/shared/api.ts`, inside `interface CrewAPI`:

```ts
  getConductorState(): Promise<ConductorSnapshot>
  createLane(request: LaneCreateRequest): Promise<ConductorLane>
  destroyLane(laneId: string): Promise<void>
  publishLane(laneId: string): Promise<PublishOutcome>
  syncLane(laneId: string): Promise<SyncOutcome>
  reconcileConductor(): Promise<ReconcileReport>
  onConductorState(cb: (state: ConductorSnapshot) => void): Unsubscribe
```

In `src/preload/index.ts`, inside the `api` object:

```ts
  getConductorState: () => ipcRenderer.invoke(IPC.CONDUCTOR_STATE),
  createLane: (request) => ipcRenderer.invoke(IPC.CONDUCTOR_LANE_CREATE, request),
  destroyLane: (laneId) => ipcRenderer.invoke(IPC.CONDUCTOR_LANE_DESTROY, laneId),
  publishLane: (laneId) => ipcRenderer.invoke(IPC.CONDUCTOR_PUBLISH, laneId),
  syncLane: (laneId) => ipcRenderer.invoke(IPC.CONDUCTOR_SYNC, laneId),
  reconcileConductor: () => ipcRenderer.invoke(IPC.CONDUCTOR_RECONCILE),
  onConductorState: (cb) => subscribe(IPC.EVT_CONDUCTOR_STATE, cb),
```

- [ ] **Step 6: Register from the main entrypoint**

In `src/main/index.ts`, alongside the other register calls, construct the backend from the lane manager and conductor and register it. The backend resolves lane ids to lanes; the runtime deals in lane objects, the IPC surface in ids, because the renderer must not hold main-process object identity.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/conductor-ipc.test.ts && npm run typecheck`
Expected: 8 tests pass; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/main/conductor-ipc.ts src/shared/types.ts src/shared/api.ts src/preload/index.ts src/main/index.ts test/conductor-ipc.test.ts
git commit -m "feat(conductor): expose the conductor over IPC"
```

---

### Task 10: The conductor panel — a pure view model and a thin component

**Files:**
- Create: `src/renderer/conductor-view-model.ts`, `src/renderer/components/ConductorPanel.tsx`
- Modify: `src/renderer/styles.css`
- Test: `test/conductor-view-model.test.ts`

**Interfaces:**
- Consumes: `ConductorSnapshot` and `PublishOutcome` from `src/shared/conductor.ts` (type-only — the renderer never imports from `src/main`); `window.crew` for the six calls and the state subscription.
- Produces: `buildRoster(snapshot)` returning `LaneRow[]`, and `describeOutcome(outcome)` returning a user-facing string, from `src/renderer/conductor-view-model.ts`.

**Why the logic lives outside the component.** Renderer tests in this repo run under Playwright against a Vite dev server — heavyweight, and wrong for deciding whether a button is enabled. Every non-trivial decision therefore goes in a pure module tested under `environment: 'node'`, exactly as `new-session-model.ts`, `grouping.ts` and `state-meta.ts` already do. `ConductorPanel.tsx` renders the rows it is given and calls `window.crew`; it holds no rules.

**The three rules the view model encodes:**
1. **Publish** is enabled only when `ahead > 0` and nothing holds the lock. Ahead is authoritative — a lane with nothing to publish has no reason to offer the button.
2. **Sync** is enabled when `behind > 0`. It is independent of the publication lock's owner only in appearance: the runtime rejects a sync while publishing, so the view model disables it too rather than letting the user press a button that will be refused.
3. **Dirty is a warning, never a block.** Publication freezes a commit, so uncommitted work cannot contaminate it — but the user should know their agent has unsaved work that will not ship. A disabled button here would be a lie about the risk.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-view-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildRoster, describeOutcome } from '../src/renderer/conductor-view-model'
import type { ConductorSnapshot } from '../src/shared/conductor'

function snapshot(overrides: Partial<ConductorSnapshot> = {}): ConductorSnapshot {
  return {
    enabled: true,
    publishing: null,
    needsAttention: false,
    lanes: [
      {
        id: 'lane-1', roleId: 'builder', kind: 'author', branch: 'crew/lane/builder',
        worktree: '/tmp/lanes/builder', sessionId: 'sess-1',
        agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' },
        status: 'working', dispatches: 0
      }
    ],
    facts: {
      'lane-1': {
        baseSha: 'base', laneTip: 'tip', ahead: 2, behind: 0,
        dirtyTracked: false, untracked: false
      }
    },
    ...overrides
  }
}

describe('buildRoster', () => {
  it('enables publish for a lane that is ahead while the lock is free', () => {
    const [row] = buildRoster(snapshot())
    expect(row.canPublish).toBe(true)
    expect(row.publishHint).toBe('2 commits ready')
  })

  it('disables publish when the lane has nothing to publish', () => {
    const state = snapshot()
    state.facts['lane-1'].ahead = 0
    const [row] = buildRoster(state)
    expect(row.canPublish).toBe(false)
    expect(row.publishHint).toBe('nothing to publish')
  })

  it('disables publish on every lane while a publication is in flight', () => {
    const rows = buildRoster(snapshot({ publishing: 'lane-1' }))
    expect(rows.every((r) => r.canPublish)).toBe(false)
    expect(rows[0].publishHint).toBe('publication in progress')
    expect(rows[0].publishing).toBe(true)
  })

  it('enables sync only when the lane is behind', () => {
    const state = snapshot()
    expect(buildRoster(state)[0].canSync).toBe(false)
    state.facts['lane-1'].behind = 3
    const [row] = buildRoster(state)
    expect(row.canSync).toBe(true)
    expect(row.syncHint).toBe('3 commits behind')
  })

  // The one rule people get backwards.
  it('warns about a dirty tree without blocking publication', () => {
    const state = snapshot()
    state.facts['lane-1'].dirtyTracked = true
    state.facts['lane-1'].untracked = true
    const [row] = buildRoster(state)
    expect(row.canPublish).toBe(true)
    expect(row.warnings).toEqual([
      'uncommitted changes will not be published',
      'untracked files will not be published'
    ])
  })

  it('surfaces a blocked lane with its reason and still allows sync', () => {
    const state = snapshot()
    state.lanes[0].status = 'blocked'
    state.lanes[0].blockedReason = 'merge conflict in shared.txt'
    state.facts['lane-1'].behind = 1
    const [row] = buildRoster(state)
    expect(row.status).toBe('blocked')
    expect(row.statusDetail).toBe('merge conflict in shared.txt')
    expect(row.canSync).toBe(true)
  })

  // Facts are gathered per lane and can legitimately be missing for one that
  // was just created. An undefined read here would crash the whole panel.
  it('renders a lane whose facts have not arrived yet without crashing', () => {
    const state = snapshot()
    state.facts = {}
    const [row] = buildRoster(state)
    expect(row.ahead).toBe(0)
    expect(row.canPublish).toBe(false)
    expect(row.publishHint).toBe('measuring…')
  })

  it('shows the agent and model that runs the lane', () => {
    const [row] = buildRoster(snapshot())
    expect(row.agentLabel).toBe('copilot-cli · gpt-6-astra')
  })

  it('omits the model suffix for a preset that takes no model', () => {
    const state = snapshot()
    state.lanes[0].agent = { presetId: 'shell', model: null }
    expect(buildRoster(state)[0].agentLabel).toBe('shell')
  })
})

describe('describeOutcome', () => {
  it('names the commit on success', () => {
    expect(describeOutcome({ ok: true, commit: 'abcdef1234', touchedPaths: [], warnings: [] }))
      .toBe('Published abcdef1')
  })

  it('lists the conflicting paths', () => {
    expect(describeOutcome({ ok: false, reason: 'conflict', conflictPaths: ['a.txt', 'b.txt'], message: 'x' }))
      .toBe('Conflict in a.txt, b.txt — resolve in the lane, then publish again')
  })

  it('explains a rejection caused by the lock rather than the lane', () => {
    expect(describeOutcome({ ok: false, reason: 'busy' }))
      .toBe('Another lane is publishing — try again in a moment')
  })

  it('does not dress a failed test run up as an error', () => {
    expect(describeOutcome({ ok: false, reason: 'tests-failed', output: 'FAIL' }))
      .toBe('Tests failed on the merge result — nothing was published')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conductor-view-model.test.ts`
Expected: FAIL — `Failed to resolve import "../src/renderer/conductor-view-model"`.

- [ ] **Step 3: Write the view model**

Create `src/renderer/conductor-view-model.ts`:

```ts
// Pure presentation rules for the conductor panel. No React, no window.crew —
// so the rules that decide what the user may press are tested in milliseconds
// under node rather than through a browser.

import type { ConductorSnapshot } from '../shared/conductor'
import type { PublishOutcome } from '../shared/conductor'
import type { LaneStatus } from '../shared/conductor'

export interface LaneRow {
  id: string
  roleId: string
  branch: string | null
  agentLabel: string
  status: LaneStatus
  statusDetail: string | null
  ahead: number
  behind: number
  publishing: boolean
  canPublish: boolean
  publishHint: string
  canSync: boolean
  syncHint: string
  warnings: string[]
}

export function buildRoster(snapshot: ConductorSnapshot): LaneRow[] {
  const locked = snapshot.publishing !== null

  return snapshot.lanes.map((lane) => {
    const facts = snapshot.facts[lane.id]
    const ahead = facts?.ahead ?? 0
    const behind = facts?.behind ?? 0

    const warnings: string[] = []
    if (facts?.dirtyTracked) warnings.push('uncommitted changes will not be published')
    if (facts?.untracked) warnings.push('untracked files will not be published')

    const canPublish = facts != null && ahead > 0 && !locked
    const canSync = facts != null && behind > 0 && !locked

    return {
      id: lane.id,
      roleId: lane.roleId,
      branch: lane.branch,
      agentLabel: lane.agent.model
        ? `${lane.agent.presetId} · ${lane.agent.model}`
        : lane.agent.presetId,
      status: lane.status,
      statusDetail: lane.blockedReason ?? null,
      ahead,
      behind,
      publishing: snapshot.publishing === lane.id,
      canPublish,
      publishHint: publishHint(facts != null, ahead, locked),
      canSync,
      syncHint: behind > 0 ? `${behind} commits behind` : 'up to date',
      warnings
    }
  })
}

function publishHint(measured: boolean, ahead: number, locked: boolean): string {
  if (!measured) return 'measuring…'
  if (locked) return 'publication in progress'
  if (ahead === 0) return 'nothing to publish'
  return `${ahead} commits ready`
}

export function describeOutcome(outcome: PublishOutcome): string {
  if (outcome.ok) return `Published ${outcome.commit.slice(0, 7)}`
  switch (outcome.reason) {
    case 'busy':
      return 'Another lane is publishing — try again in a moment'
    case 'nothing-to-publish':
      return 'Nothing to publish'
    case 'conflict':
      return `Conflict in ${outcome.conflictPaths.join(', ')} — resolve in the lane, then publish again`
    case 'tests-failed':
      return 'Tests failed on the merge result — nothing was published'
    case 'journal-failed':
      return `Could not record the operation, so nothing was run: ${outcome.message}`
    case 'ref-moved':
      return 'Someone else moved the integration branch — sync and publish again'
    case 'branch-checked-out':
      return 'The integration branch is checked out elsewhere — close that worktree first'
    default:
      return outcome.message
  }
}
```

Note `publishHint` reports the lock before `ahead`, because "publication in progress" is the actionable reason: telling the user "nothing to publish" while the lock is held would send them looking for a problem in their own lane.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conductor-view-model.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Write the component**

Create `src/renderer/components/ConductorPanel.tsx`. It subscribes to `EVT_CONDUCTOR_STATE`, fetches the initial snapshot on mount, and renders `buildRoster(snapshot)`. It contains **no conditionals about publishability** — those come from the row.

```tsx
import { useCallback, useEffect, useState } from 'react'
import { buildRoster, describeOutcome, type LaneRow } from '../conductor-view-model'
import type { ConductorSnapshot } from '../../shared/conductor'

export function ConductorPanel(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ConductorSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.crew.getConductorState().then((state) => {
      if (!cancelled) setSnapshot(state)
    })
    const off = window.crew.onConductorState(setSnapshot)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const publish = useCallback(async (laneId: string) => {
    setMessage(describeOutcome(await window.crew.publishLane(laneId)))
  }, [])

  const sync = useCallback(async (laneId: string) => {
    const outcome = await window.crew.syncLane(laneId)
    setMessage(outcome.ok ? 'Lane synced' : outcome.message)
  }, [])

  if (!snapshot || !snapshot.enabled) return null
  const rows = buildRoster(snapshot)

  return (
    <section className="conductor">
      <header className="conductor-head">
        <h2>Conductor</h2>
        {snapshot.needsAttention && (
          <span className="conductor-attention">
            An interrupted operation needs review
          </span>
        )}
      </header>
      <ul className="conductor-roster">
        {rows.map((row) => (
          <LaneRowView key={row.id} row={row} onPublish={publish} onSync={sync} />
        ))}
      </ul>
      {message && <p className="conductor-message">{message}</p>}
    </section>
  )
}

function LaneRowView({
  row,
  onPublish,
  onSync
}: {
  row: LaneRow
  onPublish: (id: string) => void
  onSync: (id: string) => void
}): JSX.Element {
  return (
    <li className={`conductor-lane conductor-lane-${row.status}`}>
      <span className="conductor-lane-role">{row.roleId}</span>
      <span className="conductor-lane-agent">{row.agentLabel}</span>
      <span className="conductor-lane-counts">
        ↑{row.ahead} ↓{row.behind}
      </span>
      {row.statusDetail && <span className="conductor-lane-detail">{row.statusDetail}</span>}
      {row.warnings.map((warning) => (
        <span key={warning} className="conductor-lane-warning">{warning}</span>
      ))}
      <button disabled={!row.canPublish} title={row.publishHint} onClick={() => onPublish(row.id)}>
        Publish
      </button>
      <button disabled={!row.canSync} title={row.syncHint} onClick={() => onSync(row.id)}>
        Sync
      </button>
    </li>
  )
}
```

Add the `.conductor*` rules to `src/renderer/styles.css` following the file's existing conventions — this repo uses one global stylesheet, not CSS modules. Mount `<ConductorPanel />` in `App.tsx` where the workspace surface renders.

- [ ] **Step 6: Run the full gate**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: the whole suite passes, typecheck exits 0, the build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/conductor-view-model.ts src/renderer/components/ConductorPanel.tsx src/renderer/styles.css src/renderer/App.tsx test/conductor-view-model.test.ts
git commit -m "feat(conductor): conductor panel with a pure view model"
```

---

### Task 11: The composer — creating a conducted workspace, its lanes and its agents

**Files:**
- Create: `src/shared/conductor-composer.ts`, `src/main/conductor-compose.ts`, `src/renderer/components/ConductorComposer.tsx`
- Test: `test/conductor-composer.test.ts`, `test/conductor-compose.test.ts`

**Interfaces:**
- Consumes: `LaneManager` from `src/main/lanes.ts`; the session manager's `create` from `src/main/session-manager.ts`; `LaneAgent`, `ConductorSettings`, `ConductorLane` from `src/shared/conductor.ts`.
- Produces: `RosterDraft`, `RosterRow`, `validateRoster(draft, limits)` from `src/shared/conductor-composer.ts`; `composeRun(deps, draft)` from `src/main/conductor-compose.ts`.

**Why this task exists.** Nothing in Tasks 1–10 can bring a conducted workspace into existence. The composer is that step: repository, integration branch, test recipe, and a roster of rows that each become a lane *and* a session.

**The new-session dialog is not touched by this task.** No new field, no conditional toggle. Conducting is a property of the workspace, so the workspace creation flow is where it is composed, and every other session in Crew — including ordinary sessions inside a conducted workspace — behaves exactly as before.

**The two rules that make this more than a form:**
1. **Validate the whole roster before creating anything.** Creating three lanes and failing on the fourth leaves orphan worktrees the user did not ask for and cannot see.
2. **Roll back every lane created so far if a row fails.** A half-built run is worse than no run, because it looks finished. And per row the order is forced: the lane worktree must exist before the session is spawned, since `cwd` is fixed at spawn and there is no `setCwd`.

- [ ] **Step 1: Write the failing validator test**

Create `test/conductor-composer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateRoster, type RosterDraft } from '../src/shared/conductor-composer'

function draft(overrides: Partial<RosterDraft> = {}): RosterDraft {
  return {
    repo: '/tmp/repo',
    integrationBranch: 'crew/integration',
    rows: [
      { roleName: 'builder', kind: 'author', agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' } },
      { roleName: 'reviewer', kind: 'reviewer', agent: { presetId: 'copilot-cli', model: 'claude-opus-5' } }
    ],
    ...overrides
  }
}

describe('validateRoster', () => {
  it('accepts a well-formed roster', () => {
    const result = validateRoster(draft(), { maxLanes: 2 })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects an empty roster, because a run with no lanes conducts nothing', () => {
    const result = validateRoster(draft({ rows: [] }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows', message: 'add at least one lane' })
  })

  it('rejects duplicate role names, which would collide as branch names', () => {
    const rows = draft().rows.map((row) => ({ ...row, roleName: 'builder' }))
    const result = validateRoster(draft({ rows }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows[1].roleName', message: 'duplicate role name' })
  })

  it('rejects a role name that is not legal in a branch ref', () => {
    const rows = [{ ...draft().rows[0], roleName: 'a lane..name' }]
    const result = validateRoster(draft({ rows }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe('rows[0].roleName')
  })

  it('rejects more rows than maxLanes', () => {
    const result = validateRoster(draft(), { maxLanes: 1 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows', message: 'at most 1 lane' })
  })

  it('requires a model for copilot-cli and forbids one where the preset takes none', () => {
    const missing = validateRoster(
      draft({ rows: [{ roleName: 'builder', kind: 'author', agent: { presetId: 'copilot-cli', model: null } }] }),
      { maxLanes: 2 }
    )
    expect(missing.errors).toContainEqual({ field: 'rows[0].agent.model', message: 'choose a model' })

    const spurious = validateRoster(
      draft({ rows: [{ roleName: 'builder', kind: 'author', agent: { presetId: 'shell', model: 'gpt-6-astra' } }] }),
      { maxLanes: 2 }
    )
    expect(spurious.errors).toContainEqual({ field: 'rows[0].agent.model', message: 'this preset takes no model' })
  })

  it('reports every problem at once, so the user fixes the form in one pass', () => {
    const result = validateRoster(
      draft({ integrationBranch: '', rows: [{ roleName: '', kind: 'author', agent: { presetId: '', model: null } }] }),
      { maxLanes: 2 }
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('rejects an integration branch that collides with a role branch', () => {
    const result = validateRoster(draft({ integrationBranch: 'crew/lane/builder' }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({
      field: 'integrationBranch',
      message: 'this is the branch lane "builder" would use'
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/conductor-composer.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the validator**

Create `src/shared/conductor-composer.ts`:

```ts
// Pure roster validation. Everything decidable without touching the filesystem
// is decided here, before the composer creates anything, because a partially
// created run leaves worktrees the user cannot see.

import type { LaneAgent, RoleKind } from './conductor'

export interface RosterRow {
  roleName: string
  kind: RoleKind
  agent: LaneAgent
}

export interface RosterDraft {
  repo: string
  integrationBranch: string
  rows: RosterRow[]
}

export interface RosterError {
  field: string
  message: string
}

export interface RosterValidation {
  ok: boolean
  errors: RosterError[]
}

/** Presets whose launch takes a model. Mirrors the session form's own rule. */
const MODEL_PRESETS = new Set(['copilot-cli'])

export function laneBranchName(roleName: string): string {
  return `crew/lane/${roleName}`
}

// A conservative subset of git check-ref-format: the runtime re-checks with git
// itself, but the user should learn about a bad name while typing it.
const LEGAL_ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function validateRoster(
  draft: RosterDraft,
  limits: { maxLanes: number }
): RosterValidation {
  const errors: RosterError[] = []

  if (!draft.repo.trim()) errors.push({ field: 'repo', message: 'choose a repository' })
  if (!draft.integrationBranch.trim()) {
    errors.push({ field: 'integrationBranch', message: 'name the integration branch' })
  }

  if (draft.rows.length === 0) {
    errors.push({ field: 'rows', message: 'add at least one lane' })
  } else if (draft.rows.length > limits.maxLanes) {
    errors.push({
      field: 'rows',
      message: `at most ${limits.maxLanes} lane${limits.maxLanes === 1 ? '' : 's'}`
    })
  }

  const seen = new Set<string>()
  draft.rows.forEach((row, index) => {
    const name = row.roleName.trim()
    if (!name) {
      errors.push({ field: `rows[${index}].roleName`, message: 'name this lane' })
    } else if (!LEGAL_ROLE.test(name) || name.includes('..')) {
      errors.push({ field: `rows[${index}].roleName`, message: 'letters, digits, dot, dash and underscore only' })
    } else if (seen.has(name)) {
      errors.push({ field: `rows[${index}].roleName`, message: 'duplicate role name' })
    }
    seen.add(name)

    if (!row.agent.presetId) {
      errors.push({ field: `rows[${index}].agent.presetId`, message: 'choose an agent' })
    } else if (MODEL_PRESETS.has(row.agent.presetId) && !row.agent.model) {
      errors.push({ field: `rows[${index}].agent.model`, message: 'choose a model' })
    } else if (!MODEL_PRESETS.has(row.agent.presetId) && row.agent.model) {
      errors.push({ field: `rows[${index}].agent.model`, message: 'this preset takes no model' })
    }

    // The integration branch is a real branch; a lane branch of the same name
    // would make publication merge a lane into itself.
    if (name && draft.integrationBranch.trim() === laneBranchName(name)) {
      errors.push({
        field: 'integrationBranch',
        message: `this is the branch lane "${name}" would use`
      })
    }
  })

  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run test/conductor-composer.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Write the failing orchestration test**

Create `test/conductor-compose.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneManager } from '../src/main/lanes'
import { composeRun } from '../src/main/conductor-compose'
import type { ConductorSettings } from '../src/shared/conductor'
import type { RosterDraft } from '../src/shared/conductor-composer'

let root: string
let settings: ConductorSettings

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-compose-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-b', 'main', repo])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env: { ...process.env, ...ENV } })
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo, env: { ...process.env, ...ENV } })
  execFileSync('git', ['branch', 'crew/integration'], { cwd: repo })
  settings = {
    repo,
    integrationBranch: 'crew/integration',
    integrationWorktree: join(root, 'integration'),
    lanesDir: join(root, 'lanes'),
    maxLanes: 3,
    test: null
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function draft(): RosterDraft {
  return {
    repo: settings.repo,
    integrationBranch: settings.integrationBranch,
    rows: [
      { roleName: 'builder', kind: 'author', agent: { presetId: 'shell', model: null } },
      { roleName: 'scout', kind: 'author', agent: { presetId: 'shell', model: null } }
    ]
  }
}

describe('composeRun', () => {
  it('creates a lane and a session per row, and reports them in order', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn(async (req: { cwd: string }) => ({ id: `sess-${req.cwd.split('/').pop()}` }))
    const result = await composeRun({ lanes, settings, createSession }, draft())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lanes.map((l) => l.roleId)).toEqual(['builder', 'scout'])
    expect(result.lanes.map((l) => l.sessionId)).toEqual(['sess-builder', 'sess-scout'])
    for (const lane of result.lanes) expect(existsSync(lane.worktree)).toBe(true)
  })

  // cwd is fixed at spawn and there is no setCwd, so the worktree must exist
  // before the session does.
  it('spawns each session with cwd set to its own lane worktree', async () => {
    const lanes = createLaneManager(settings)
    const seen: string[] = []
    const createSession = vi.fn(async (req: { cwd: string }) => {
      expect(existsSync(req.cwd)).toBe(true)
      seen.push(req.cwd)
      return { id: 'sess' }
    })
    await composeRun({ lanes, settings, createSession }, draft())
    expect(new Set(seen).size).toBe(2)
  })

  it('creates the integration worktree once, detached', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn(async () => ({ id: 'sess' }))
    await composeRun({ lanes, settings, createSession }, draft())
    expect(existsSync(settings.integrationWorktree)).toBe(true)
    const head = execFileSync('git', ['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: settings.integrationWorktree, encoding: 'utf8'
    }).trim()
    expect(head).toBe('')
  })

  it('rejects an invalid roster without creating anything', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn()
    const bad = draft()
    bad.rows[1].roleName = 'builder'
    const result = await composeRun({ lanes, settings, createSession }, bad)

    expect(result.ok).toBe(false)
    expect(createSession).not.toHaveBeenCalled()
    expect(existsSync(settings.lanesDir)).toBe(false)
  })

  // A half-built run is worse than no run, because it looks finished.
  it('rolls every lane back when a later row fails to spawn', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn()
      .mockResolvedValueOnce({ id: 'sess-1' })
      .mockRejectedValueOnce(new Error('preset not installed'))
    const result = await composeRun({ lanes, settings, createSession }, draft())

    expect(result).toMatchObject({ ok: false, failedRow: 1 })
    const branches = execFileSync('git', ['branch', '--list', 'crew/lane/*'], {
      cwd: settings.repo, encoding: 'utf8'
    }).trim()
    expect(branches).toBe('')
    const worktrees = execFileSync('git', ['worktree', 'list'], {
      cwd: settings.repo, encoding: 'utf8'
    })
    expect(worktrees).not.toContain('crew/lane/')
  })

  it('removes the lane it had just created when that row is the one that fails', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn().mockRejectedValue(new Error('spawn failed'))
    const result = await composeRun({ lanes, settings, createSession }, draft())
    expect(result).toMatchObject({ ok: false, failedRow: 0 })
    expect(existsSync(join(settings.lanesDir, 'builder'))).toBe(false)
  })

  it('reports the underlying failure rather than a generic one', async () => {
    const lanes = createLaneManager(settings)
    const createSession = vi.fn().mockRejectedValue(new Error('preset not installed'))
    const result = await composeRun({ lanes, settings, createSession }, draft())
    if (result.ok) throw new Error('expected failure')
    expect(result.message).toContain('preset not installed')
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run test/conductor-compose.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 7: Write the composer**

Create `src/main/conductor-compose.ts`:

```ts
// Brings a conducted workspace into existence: integration worktree, then one
// lane and one session per roster row. All-or-nothing.

import { validateRoster, type RosterDraft, type RosterError } from '../shared/conductor-composer'
import type { LaneManager } from './lanes'
import type { ConductorLane, ConductorSettings } from '../shared/conductor'

export interface ComposeDeps {
  lanes: LaneManager
  settings: ConductorSettings
  /** Narrowed to what the composer needs, so this is testable without a PTY. */
  createSession(request: {
    cwd: string
    presetId: string
    model: string | null
    label: string
  }): Promise<{ id: string }>
}

export type ComposeResult =
  | { ok: true; lanes: ConductorLane[] }
  | { ok: false; errors: RosterError[] }
  | { ok: false; failedRow: number; message: string; errors: RosterError[] }

export async function composeRun(
  deps: ComposeDeps,
  draft: RosterDraft
): Promise<ComposeResult> {
  // 1. Everything decidable up front is decided up front.
  const validation = validateRoster(draft, { maxLanes: deps.settings.maxLanes })
  if (!validation.ok) return { ok: false, errors: validation.errors }

  await deps.lanes.ensureIntegrationWorktree()

  const created: ConductorLane[] = []
  for (const [index, row] of draft.rows.entries()) {
    try {
      // 2. The worktree must exist before the session, because cwd is fixed at
      //    spawn and there is no setCwd.
      const lane = await deps.lanes.create(row.roleName, row.agent)
      created.push(lane)

      const session = await deps.createSession({
        cwd: lane.worktree,
        presetId: row.agent.presetId,
        model: row.agent.model,
        label: row.roleName
      })
      lane.sessionId = session.id
    } catch (error) {
      // 3. Roll back, newest first, so a lane is never left without its session.
      await rollback(deps, created)
      return {
        ok: false,
        failedRow: index,
        message: error instanceof Error ? error.message : String(error),
        errors: []
      }
    }
  }

  return { ok: true, lanes: created }
}

async function rollback(deps: ComposeDeps, created: ConductorLane[]): Promise<void> {
  for (const lane of [...created].reverse()) {
    try {
      await deps.lanes.destroy(lane, { force: true })
    } catch (error) {
      // Report, never throw: a failure to clean up must not replace the real
      // cause of the failure with a second, less useful one.
      console.warn(`[crew] could not roll back lane ${lane.roleId}:`, error)
    }
  }
}
```

`force: true` is correct here and nowhere else: these worktrees were created seconds ago by this function and contain nothing the user made.

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run test/conductor-compose.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 9: Wire it up**

- Add `CONDUCTOR_COMPOSE: 'conductor:compose'` to the `IPC` object, a `compose(draft)` method on `ConductorBackend`, a handler in `src/main/conductor-ipc.ts` that broadcasts state on success, a `composeRun` wrapper in `src/preload/index.ts`, and `composeConductedWorkspace(draft): Promise<ComposeResult>` on `CrewAPI`.
- Create `src/renderer/components/ConductorComposer.tsx`: the repository and integration-branch fields, the test-recipe fields, and the roster table. **Reuse the existing preset and Copilot model pickers** from the session form rather than writing new ones — that reuse is what makes per-lane reasoning diversity a setting instead of a feature. Render `validateRoster` errors against their `field` keys; the Create button is disabled while `ok` is false.
- Extend `test/conductor-ipc.test.ts` with a case asserting the compose channel is registered and broadcasts on success.

- [ ] **Step 10: Run the full gate and commit**

Run: `npx vitest run && npm run typecheck && npm run build`

```bash
git add src/shared/conductor-composer.ts src/main/conductor-compose.ts src/renderer/components/ConductorComposer.tsx src/shared/conductor.ts src/shared/types.ts src/shared/api.ts src/preload/index.ts src/main/conductor-ipc.ts test/conductor-composer.test.ts test/conductor-compose.test.ts test/conductor-ipc.test.ts
git commit -m "feat(conductor): compose a conducted workspace, its lanes and its agents"
```

---

### Task 12: The plan proposal — parsing an agent's roster and reconciling it with reality

**Files:**
- Create: `src/shared/conductor-proposal.ts`
- Test: `test/conductor-proposal.test.ts`, fixtures under `test/fixtures/conductor-proposals/`
- Modify: `src/renderer/components/ConductorComposer.tsx` (accept a reconciled roster as its initial state)

**Interfaces:**
- Consumes: `RosterRow`, `validateRoster` from `src/shared/conductor-composer.ts`; `RoleKind`, `LaneAgent` from `src/shared/conductor.ts`.
- Produces: `PlanProposal`, `ProposalNote`, `parseProposal(text)`, `reconcileProposal(proposal, reality, limits)` from `src/shared/conductor-proposal.ts`.

**What this is.** The conductor session — an agent that reads the repository, plans the work and proposes which lanes exist and which model runs each — writes `.crew/conductor-plan.json`. This task builds the half of that feature that needs **no agent**: reading that file and turning it into a roster the composer can show.

**Why only this half is in Phase 1.** Spawning the conductor session and watching for its file depends on the transport spike (Phase 1b) and cannot be proven here. But every actual hazard is in this half — hallucinated model IDs, presets the user has not installed, oversized rosters, malformed JSON — and all of it is pure and deterministic. It ships now, tested against fixture files, and is exercised by loading a proposal from disk.

**The rule that matters more than the rest:** an unknown model is **flagged, never substituted**. Quietly swapping in a default would spend the user's credits on a model they did not choose, and nothing in the UI would tell them. Every other rule here is ordinary input validation; this one is the difference between a helpful proposal and a silent bill.

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/conductor-proposals/`:

`good.json`:
```json
{
  "summary": "Split the importer work from its review.",
  "rows": [
    { "roleName": "importer", "kind": "author", "presetId": "copilot-cli", "model": "claude-opus-5", "rationale": "Long refactor across many files; favours a large context model." },
    { "roleName": "reviewer", "kind": "reviewer", "presetId": "copilot-cli", "model": "gpt-6-astra", "rationale": "A second, different reasoner so review is not self-review." }
  ]
}
```

`hallucinated-model.json` — identical, but the first row's model is `"gpt-9-omega"`.

`truncated.json` — valid JSON up to the second row, then cut off mid-object.

- [ ] **Step 2: Write the failing test**

Create `test/conductor-proposal.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseProposal, reconcileProposal } from '../src/shared/conductor-proposal'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/conductor-proposals/${name}`, import.meta.url), 'utf8')

const reality = {
  models: ['gpt-6-astra', 'claude-opus-5', 'grok-4.7'],
  presets: ['copilot-cli', 'shell', 'claude']
}

describe('parseProposal', () => {
  it('reads a well-formed proposal', () => {
    const parsed = parseProposal(fixture('good.json'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.rows).toHaveLength(2)
    expect(parsed.proposal.summary).toContain('importer')
  })

  // A missing or half-written file is a normal state, not an error: the agent
  // may simply not have finished.
  it('reports malformed JSON as not-ready rather than throwing', () => {
    const parsed = parseProposal(fixture('truncated.json'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('unreadable')
  })

  it('reports an empty file as not-ready', () => {
    expect(parseProposal('')).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects JSON that parses but is not a proposal', () => {
    expect(parseProposal('[1,2,3]')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(parseProposal('{"summary":"x"}')).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('tolerates the fenced code block agents habitually wrap JSON in', () => {
    const fenced = '```json\n' + fixture('good.json') + '\n```\n'
    expect(parseProposal(fenced).ok).toBe(true)
  })

  it('defaults a missing kind to author rather than discarding the row', () => {
    const parsed = parseProposal('{"summary":"s","rows":[{"roleName":"a","presetId":"shell"}]}')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.rows[0].kind).toBe('author')
    expect(parsed.proposal.rows[0].model).toBeNull()
  })
})

describe('reconcileProposal', () => {
  it('passes a proposal whose models and presets all exist', () => {
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    expect(result.notes).toEqual([])
    expect(result.rows.map((r) => r.roleName)).toEqual(['importer', 'reviewer'])
    expect(result.rows[0].agent.model).toBe('claude-opus-5')
  })

  // The rule this whole module exists for.
  it('flags a hallucinated model and does NOT substitute a default', () => {
    const parsed = parseProposal(fixture('hallucinated-model.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })

    expect(result.rows[0].agent.model).toBeNull()
    expect(result.notes).toContainEqual({
      row: 0,
      severity: 'blocking',
      message: 'gpt-9-omega is not an available model — choose one'
    })
    // Nothing silently picked for the user.
    expect(result.rows[0].agent.model).not.toBe('gpt-6-astra')
  })

  it('flags a preset the user has not installed', () => {
    const proposal = {
      summary: 's',
      rows: [{ roleName: 'a', kind: 'author' as const, presetId: 'opencode', model: null, rationale: '' }]
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 3 })
    expect(result.notes[0]).toMatchObject({ row: 0, severity: 'blocking' })
    expect(result.notes[0].message).toContain('opencode')
  })

  it('drops rows beyond maxLanes and says so, rather than truncating quietly', () => {
    const proposal = {
      summary: 's',
      rows: ['a', 'b', 'c'].map((roleName) => ({
        roleName, kind: 'author' as const, presetId: 'shell', model: null, rationale: ''
      }))
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 2 })
    expect(result.rows).toHaveLength(2)
    expect(result.notes).toContainEqual({
      row: -1,
      severity: 'warning',
      message: 'proposed 3 lanes; at most 2 are allowed, so 1 was dropped'
    })
  })

  it('carries each rationale through, because it is why the user trusts the row', () => {
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    expect(result.rows[1].rationale).toContain('not self-review')
  })

  it('produces rows the composer validator accepts when nothing is flagged', async () => {
    const { validateRoster } = await import('../src/shared/conductor-composer')
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    const validation = validateRoster(
      { repo: '/tmp/repo', integrationBranch: 'crew/integration', rows: result.rows },
      { maxLanes: 3 }
    )
    expect(validation.ok).toBe(true)
  })

  it('never returns a row the user cannot fix in the form', () => {
    const proposal = {
      summary: 's',
      rows: [{ roleName: '', kind: 'author' as const, presetId: 'shell', model: null, rationale: '' }]
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 2 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].roleName).toBe('')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run test/conductor-proposal.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 4: Write the module**

Create `src/shared/conductor-proposal.ts`:

```ts
// An agent-written roster proposal is untrusted input. This module turns
// `.crew/conductor-plan.json` into rows the composer can show, and says
// plainly what it could not honour.

import type { RosterRow } from './conductor-composer'
import type { RoleKind } from './conductor'

export interface ProposalRow {
  roleName: string
  kind: RoleKind
  presetId: string
  model: string | null
  rationale: string
}

export interface ProposalSection {
  heading: string
  body: string
}

export interface PlanProposal {
  summary: string
  /** The conductor's argument for the plan. Plain text only — it is rendered
   *  as escaped text, never as markup. Absent is normal, not an error. */
  narrative: ProposalSection[]
  rows: ProposalRow[]
}

export type ParseResult =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; reason: 'unreadable' }

export interface ProposalNote {
  /** Row index, or -1 for a note about the roster as a whole. */
  row: number
  severity: 'blocking' | 'warning'
  message: string
}

export interface ReconciledRoster {
  summary: string
  narrative: ProposalSection[]
  rows: (RosterRow & { rationale: string })[]
  notes: ProposalNote[]
}

/** Agents habitually wrap JSON in a fence even when told not to. */
function unfence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (fenced ? fenced[1] : text).trim()
}

export function parseProposal(text: string): ParseResult {
  const body = unfence(text)
  if (!body) return { ok: false, reason: 'unreadable' }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    // A half-written file is the expected state while the agent is still
    // working, not an error worth surfacing.
    return { ok: false, reason: 'unreadable' }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'unreadable' }
  }
  const candidate = raw as Record<string, unknown>
  if (!Array.isArray(candidate.rows)) return { ok: false, reason: 'unreadable' }

  const rows: ProposalRow[] = []
  for (const entry of candidate.rows) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    rows.push({
      roleName: typeof row.roleName === 'string' ? row.roleName : '',
      kind: row.kind === 'reviewer' ? 'reviewer' : 'author',
      presetId: typeof row.presetId === 'string' ? row.presetId : '',
      model: typeof row.model === 'string' && row.model ? row.model : null,
      rationale: typeof row.rationale === 'string' ? row.rationale : ''
    })
  }

  const narrative: ProposalSection[] = []
  if (Array.isArray(candidate.narrative)) {
    for (const entry of candidate.narrative) {
      if (typeof entry !== 'object' || entry === null) continue
      const section = entry as Record<string, unknown>
      const heading = typeof section.heading === 'string' ? section.heading : ''
      const body = typeof section.body === 'string' ? section.body : ''
      // A section with neither heading nor body renders as an empty band.
      if (!heading && !body) continue
      narrative.push({ heading, body })
    }
  }

  return {
    ok: true,
    proposal: {
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      narrative,
      rows
    }
  }
}

export function reconcileProposal(
  proposal: PlanProposal,
  reality: { models: string[]; presets: string[] },
  limits: { maxLanes: number }
): ReconciledRoster {
  const notes: ProposalNote[] = []

  let rows = proposal.rows
  if (rows.length > limits.maxLanes) {
    const dropped = rows.length - limits.maxLanes
    notes.push({
      row: -1,
      severity: 'warning',
      message: `proposed ${rows.length} lanes; at most ${limits.maxLanes} are allowed, so ${dropped} ${dropped === 1 ? 'was' : 'were'} dropped`
    })
    rows = rows.slice(0, limits.maxLanes)
  }

  const reconciled = rows.map((row, index) => {
    if (row.presetId && !reality.presets.includes(row.presetId)) {
      notes.push({
        row: index,
        severity: 'blocking',
        message: `${row.presetId} is not an installed agent — choose one`
      })
    }

    // Flagged, never substituted: picking a model on the user's behalf spends
    // their credits on something they did not choose and never saw.
    let model = row.model
    if (model && !reality.models.includes(model)) {
      notes.push({
        row: index,
        severity: 'blocking',
        message: `${model} is not an available model — choose one`
      })
      model = null
    }

    return {
      roleName: row.roleName,
      kind: row.kind,
      agent: { presetId: row.presetId, model },
      rationale: row.rationale
    }
  })

  return { summary: proposal.summary, narrative: proposal.narrative, rows: reconciled, notes }
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/conductor-proposal.test.ts`
Expected: PASS — 15 tests.

- [ ] **Step 6: Let the composer open on a proposal**

`ConductorComposer.tsx` takes an optional `initial?: ReconciledRoster`. When present it pre-fills the roster table, shows `summary` above it and each row's `rationale` beneath that row, and renders `notes` against their rows — blocking notes disable **Create** exactly as a validation error does.

Nothing about the manual path changes. With no `initial`, the composer behaves precisely as Task 11 built it, which is what makes the agent-planned path an accelerator rather than a dependency.

Add a **Load a plan file…** control that reads a `.json` from disk through `parseProposal` + `reconcileProposal`. This is the Phase 1 way to exercise the whole path with no agent running, and it stays useful afterwards.

`narrative` is carried through untouched here and is **not** rendered by the composer — Task 13 owns the reading experience. The composer stays a form.

- [ ] **Step 7: Run the full gate and commit**

Run: `npx vitest run && npm run typecheck && npm run build`

```bash
git add src/shared/conductor-proposal.ts src/renderer/components/ConductorComposer.tsx test/conductor-proposal.test.ts test/fixtures/conductor-proposals
git commit -m "feat(conductor): parse and reconcile an agent-proposed roster"
```

---

### Task 13: The plan view — rendering a proposal as a document you read

A reconciled roster is a table. The question the user is actually in a position
to disagree with is *why this decomposition*, and a table cannot answer it. This
task turns a `ReconciledRoster` into a readable document and renders it — in
Crew, from structured data, with every value escaped. The conductor supplies no
markup at any point.

**Files:**
- Create: `src/renderer/conductor-plan-document.ts`
- Create: `src/renderer/components/ConductorPlanDialog.tsx`
- Create: `test/conductor-plan-document.test.ts`

**Interfaces:**
- Consumes: `ReconciledRoster`, `ProposalSection`, `ProposalNote` from `src/shared/conductor-proposal` (Task 12); `ConductorComposer` from Task 11.
- Produces: `buildPlanDocument(roster: ReconciledRoster): PlanDocument`, and `ConductorPlanDialog`.

- [ ] **Step 1: Write the failing test**

Create `test/conductor-plan-document.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPlanDocument } from '../src/renderer/conductor-plan-document'
import type { ReconciledRoster } from '../src/shared/conductor-proposal'

function roster(over: Partial<ReconciledRoster> = {}): ReconciledRoster {
  return {
    summary: 'Split the importer from the renderer.',
    narrative: [],
    rows: [
      {
        roleName: 'importer',
        kind: 'author',
        agent: { presetId: 'claude', model: 'opus' },
        rationale: 'Long refactor, needs the strongest model.'
      }
    ],
    notes: [],
    ...over
  }
}

describe('buildPlanDocument', () => {
  it('opens with the summary', () => {
    const doc = buildPlanDocument(roster())
    expect(doc.bands[0]).toEqual({
      kind: 'summary',
      heading: 'The plan',
      paragraphs: ['Split the importer from the renderer.']
    })
  })

  it('omits the summary band when there is no summary', () => {
    const doc = buildPlanDocument(roster({ summary: '   ' }))
    expect(doc.bands).toHaveLength(0)
  })

  it('keeps narrative sections in order after the summary', () => {
    const doc = buildPlanDocument(
      roster({
        narrative: [
          { heading: 'Approach', body: 'One lane per seam.' },
          { heading: 'Risks', body: 'The importer touches the schema.' }
        ]
      })
    )
    expect(doc.bands.map((b) => b.heading)).toEqual(['The plan', 'Approach', 'Risks'])
    expect(doc.bands[1].kind).toBe('section')
  })

  it('splits a body into paragraphs on blank lines', () => {
    const doc = buildPlanDocument(
      roster({ narrative: [{ heading: 'Approach', body: 'First.\n\n\nSecond.\n' }] })
    )
    expect(doc.bands[1].paragraphs).toEqual(['First.', 'Second.'])
  })

  it('treats markup in a body as literal text, never as structure', () => {
    const body = '<script>alert(1)</script> **not bold**'
    const doc = buildPlanDocument(roster({ narrative: [{ heading: 'h', body }] }))
    expect(doc.bands[1].paragraphs).toEqual([body])
  })

  it('labels a null model rather than inventing one', () => {
    const r = roster()
    r.rows[0].agent.model = null
    const doc = buildPlanDocument(r)
    expect(doc.rows[0].modelLabel).toBe('default model')
  })

  it('attaches a blocking note to its own row and refuses Create', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 0, severity: 'blocking', message: 'opus is not an available model — choose one' }] })
    )
    expect(doc.rows[0].problems).toEqual(['opus is not an available model — choose one'])
    expect(doc.blockingCount).toBe(1)
    expect(doc.canCreate).toBe(false)
  })

  it('lets warnings through — they inform, they do not block', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 0, severity: 'warning', message: 'no reviewer proposed' }] })
    )
    expect(doc.rows[0].warnings).toEqual(['no reviewer proposed'])
    expect(doc.canCreate).toBe(true)
  })

  it('collects roster-wide notes separately from row notes', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: -1, severity: 'warning', message: 'proposed 5 lanes; 3 were dropped' }] })
    )
    expect(doc.rosterNotes).toEqual(['proposed 5 lanes; 3 were dropped'])
    expect(doc.rows[0].warnings).toEqual([])
  })

  it('ignores a note pointing at a row that does not exist', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 7, severity: 'blocking', message: 'stale' }] })
    )
    expect(doc.rows[0].problems).toEqual([])
    expect(doc.canCreate).toBe(true)
  })

  it('never hands agent text to the DOM as markup', () => {
    const source = readFileSync('src/renderer/components/ConductorPlanDialog.tsx', 'utf8')
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/conductor-plan-document.test.ts`
Expected: FAIL — `Failed to resolve import ".../conductor-plan-document"`.

- [ ] **Step 3: Write the document model**

Create `src/renderer/conductor-plan-document.ts`:

```ts
// A reconciled proposal, arranged for reading. Pure: no DOM, no React, no IO.
//
// Everything here is plain text. The conductor never supplies markup and this
// module never interprets any: a body containing HTML comes out as a literal
// paragraph string and React escapes it on render. That is the whole security
// posture of the plan view, and the test above is what holds it in place.

import type { ReconciledRoster } from '../shared/conductor-proposal'

export interface PlanDocumentBand {
  kind: 'summary' | 'section'
  heading: string
  paragraphs: string[]
}

export interface PlanDocumentRow {
  roleName: string
  kindLabel: 'Author' | 'Reviewer'
  presetId: string
  modelLabel: string
  rationale: string
  problems: string[]
  warnings: string[]
}

export interface PlanDocument {
  bands: PlanDocumentBand[]
  rows: PlanDocumentRow[]
  rosterNotes: string[]
  blockingCount: number
  canCreate: boolean
}

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export function buildPlanDocument(roster: ReconciledRoster): PlanDocument {
  const bands: PlanDocumentBand[] = []

  const summary = paragraphs(roster.summary)
  if (summary.length > 0) {
    bands.push({ kind: 'summary', heading: 'The plan', paragraphs: summary })
  }

  for (const section of roster.narrative) {
    const body = paragraphs(section.body)
    if (body.length === 0 && !section.heading.trim()) continue
    bands.push({ kind: 'section', heading: section.heading.trim(), paragraphs: body })
  }

  const rows: PlanDocumentRow[] = roster.rows.map((row) => ({
    roleName: row.roleName,
    kindLabel: row.kind === 'reviewer' ? 'Reviewer' : 'Author',
    presetId: row.agent.presetId,
    // Never invent a model name here. A null model means the preset's own
    // default will be used, and saying so is the honest label.
    modelLabel: row.agent.model ?? 'default model',
    rationale: row.rationale,
    problems: [],
    warnings: []
  }))

  const rosterNotes: string[] = []
  let blockingCount = 0

  for (const note of roster.notes) {
    if (note.row === -1) {
      rosterNotes.push(note.message)
      if (note.severity === 'blocking') blockingCount += 1
      continue
    }
    const target = rows[note.row]
    // A note aimed past the end of the roster is stale, not fatal. Dropping it
    // is safe; counting it as blocking would wedge Create with no visible cause.
    if (!target) continue
    if (note.severity === 'blocking') {
      target.problems.push(note.message)
      blockingCount += 1
    } else {
      target.warnings.push(note.message)
    }
  }

  return { bands, rows, rosterNotes, blockingCount, canCreate: blockingCount === 0 }
}
```

- [ ] **Step 4: Write the dialog**

Create `src/renderer/components/ConductorPlanDialog.tsx`:

```tsx
import { useMemo, useState } from 'react'
import type { ReconciledRoster } from '../../shared/conductor-proposal'
import { buildPlanDocument } from '../conductor-plan-document'
import { ConductorComposer } from './ConductorComposer'

interface Props {
  roster: ReconciledRoster
  onCreate: (roster: ReconciledRoster) => void
  onCancel: () => void
}

export function ConductorPlanDialog({ roster, onCreate, onCancel }: Props): JSX.Element {
  const doc = useMemo(() => buildPlanDocument(roster), [roster])
  const [editing, setEditing] = useState(false)

  return (
    <div className="plan-doc" role="dialog" aria-label="Proposed plan">
      {doc.bands.map((band, i) => (
        <section key={i} className={`plan-doc__band plan-doc__band--${band.kind}`}>
          {band.heading && <h2 className="plan-doc__heading">{band.heading}</h2>}
          {band.paragraphs.map((p, j) => (
            <p key={j} className="plan-doc__p">{p}</p>
          ))}
        </section>
      ))}

      {doc.rosterNotes.length > 0 && (
        <ul className="plan-doc__notes">
          {doc.rosterNotes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}

      <table className="plan-doc__roster">
        <thead>
          <tr><th>Role</th><th>Kind</th><th>Agent</th><th>Model</th><th>Why</th></tr>
        </thead>
        <tbody>
          {doc.rows.map((row, i) => (
            <tr key={i} className={row.problems.length > 0 ? 'plan-doc__row--blocked' : undefined}>
              <td>{row.roleName}</td>
              <td>{row.kindLabel}</td>
              <td>{row.presetId}</td>
              <td>{row.modelLabel}</td>
              <td>
                {row.rationale}
                {row.problems.map((p, j) => <div key={j} className="plan-doc__problem">{p}</div>)}
                {row.warnings.map((w, j) => <div key={j} className="plan-doc__warning">{w}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing ? (
        <ConductorComposer initial={roster} onCreate={onCreate} onCancel={() => setEditing(false)} />
      ) : (
        <div className="plan-doc__actions">
          <button onClick={onCancel}>Cancel</button>
          <button onClick={() => setEditing(true)}>Edit the roster</button>
          <button
            disabled={!doc.canCreate}
            title={doc.canCreate ? undefined : `${doc.blockingCount} problem(s) must be resolved first`}
            onClick={() => onCreate(roster)}
          >
            Create
          </button>
        </div>
      )}
    </div>
  )
}
```

Read first, edit second, Create third. **Create is disabled while any blocking
note stands** — the same rule the composer enforces, stated in the same place
the user is reading.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run test/conductor-plan-document.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 6: Run the full gate and commit**

Run: `npx vitest run && npm run typecheck && npm run build`

```bash
git add src/renderer/conductor-plan-document.ts src/renderer/components/ConductorPlanDialog.tsx test/conductor-plan-document.test.ts
git commit -m "feat(conductor): render a proposed plan as a document before the composer"
```

---

## Verification

After every task:

```bash
npx vitest run && npm run typecheck && npm run build
```

There is **no `npm run lint`** in this repository; those three commands are the gate.

Manual verification of the finished phase, in one sitting:

1. Enable the conductor on a scratch git repository with two lanes.
2. Commit in lane A, press **Publish** — the integration branch advances, lane A's ahead returns to 0, lane B shows behind 1.
3. Press **Sync** on lane B — behind returns to 0.
4. Commit conflicting changes in both lanes, publish A, then publish B — B blocks with a named conflict path, the integration worktree is clean, and A can still publish afterwards.
5. Leave uncommitted work in a lane and publish — it succeeds with a warning, and the published commit does not contain the uncommitted content.
6. Quit the app mid-publication (or simulate by journalling an `intent` by hand) and relaunch — the panel reports an operation needing review and **nothing resumes by itself**.

## What Phase 1 deliberately does not do

- No router, no dispatcher, no `ready[]` queue, no autonomous agent turns. A concurrent publish request is **rejected**, not queued; queueing belongs to the Phase 2 router.
- No review lanes, no verdicts, no `reviewing` status transitions driven by an agent. The types carry them so Phase 2 adds behaviour rather than reshaping data, but nothing in Phase 1 produces them.
- No bulletins. The `notified` journal phase is written so the journal's shape — and therefore recovery — is identical in Phase 2, but Phase 1 sends nothing.
- **No conductor session is spawned.** Task 12 builds the parser and the
  reconciliation that make an agent-written roster safe to show, and the
  composer can load a proposal from a file — but spawning the conductor agent
  in its plan worktree, installing its skill and watching for
  `.crew/conductor-plan.json` is Phase 1c, because it depends on the transport
  spike. The composer form is the floor under both paths.
- No transport spike. Whether Copilot CLI exposes a usable turn-completion signal is the subject of Phase 1b and is not assumed here.
