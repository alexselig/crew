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
  /** Which workspace's Conductor created this lane. Optional: lanes.create()
   *  (Task 5's runtime, already scoped to one workspace) never sets it, and
   *  every in-memory consumer of a lane already knows which workspace it
   *  came from. It exists solely for the store's flat conductorLanes
   *  collection (Task 1 — one ConductorLane[] array, not indexed by
   *  workspace): without a discriminator, hydrating one workspace's backend
   *  would either see every other workspace's lanes too, or saving would
   *  silently drop them. Set by the backend only when it persists a lane
   *  (see createShippedConductorBackend's persistLanes), never by
   *  lanes.create() itself. */
  workspaceId?: string
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

/** ConductorSettings, persisted per workspace. One record per workspaceId. */
export interface ConductorConfig {
  workspaceId: string
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

/** How an interrupted publication is classified on restart. Declared here
 *  rather than in conductor-recovery.ts so that this file, which every layer
 *  depends on, depends on nothing itself. */
export type Classification =
  | 'complete'
  | 'not-started'
  | 'interrupted-merge'
  | 'interrupted-tests'
  | 'merged-unpublished'
  /** The branch already moved to the recorded result, but no 'published'
   *  entry was ever journaled — the two-write CAS landed and the crash hit
   *  between the ref update and the journal write. Redoing the publish
   *  would double-apply the merge, so this is never safe to redo. */
  | 'published-unrecorded'
  | 'published-unnotified'
  | 'externally-modified'

// Everything below crosses the IPC boundary and is read by the renderer, which
// must never import from src/main. That is the only reason these live here
// rather than beside the runtime that produces them.

export type PublishFailure =
  | { ok: false; reason: 'busy' }
  | { ok: false; reason: 'nothing-to-publish' }
  /** Task 5, finding 5: refused at the backend boundary because the last
   *  reconcile() found an interrupted operation still needing a human, and
   *  papering over that with a fresh publish would risk double-applying or
   *  losing whatever it left behind. Distinct from 'busy': the lock may be
   *  completely free — this is a standing hold, not a transient one. */
  | { ok: false; reason: 'needs-attention'; message: string }
  | { ok: false; reason: 'journal-failed'; message: string }
  | { ok: false; reason: 'conflict'; conflictPaths: string[]; message: string }
  | { ok: false; reason: 'tests-failed'; output: string }
  | { ok: false; reason: 'ref-moved' | 'branch-checked-out' | 'error'; message: string }

export type PublishOutcome =
  | { ok: true; commit: string; touchedPaths: string[]; warnings: string[] }
  | PublishFailure

export type SyncOutcome =
  | { ok: true; resultSha: string; fastForward: boolean }
  | { ok: false; reason: 'busy' | 'conflict' | 'needs-attention' | 'error'; conflictPaths?: string[]; message: string }

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
  /** Set (true) only when this report is a stand-in produced because the
   *  single-flight lock was already held (Task 5, finding 4): the shipped
   *  backend catches conductor.reconcile()'s thrown ConductorBusyError at
   *  the IPC boundary and returns this shape instead, so a caller never has
   *  to string-match a thrown error's message to tell "busy, try again"
   *  apart from "ran, and found nothing wrong". Absent (not merely false)
   *  when reconcile actually ran to completion. */
  busy?: boolean
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
