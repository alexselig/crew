# Conducted workspaces — a conductor that serializes integration between sessions

**Status:** Design proposal — revised after adversarial review
**Date:** 2026-09-28
**Author:** brainstorming session
**Reviewers:** Grok 4.7, GPT-6 Sol, GPT-6 Astra (independent, adversarial)

## Summary

Add a **conducted** toggle to a workspace. In a conducted workspace the member
sessions stop being independent coworkers and become a **coordinated team**:
they work in parallel in isolated git worktrees, they are told what their
teammates have landed, and **publication to the shared integration branch is
serialized**, so two agents cannot land conflicting work concurrently.

Crew sits in the middle of every exchange. It decides *when* work is published
and *who may publish* (deterministic, testable, free); a single headless LLM run
writes *what one agent tells another* (the one job rules are bad at).

### What this guarantees, precisely

Three independent reviews found the original draft's guarantees overstated. The
honest ones:

| Claim | Status |
|---|---|
| Two lanes cannot *publish* to the integration branch concurrently | **Guaranteed** — single-flight owner plus compare-and-swap on the ref |
| Two lanes cannot edit the same working copy | **Guaranteed** — separate worktrees |
| Textually conflicting check-ins are caught before landing | **Guaranteed** — publication rebases onto the pinned base, or fails |
| *Semantic* conflicts are prevented | **NOT guaranteed.** Two lanes can change an interface in non-overlapping hunks and both land clean. The test command is a best-effort net, not a proof |
| Agents cannot run `git` on their own | **NOT guaranteed.** Member sessions are full PTYs. The publication lock binds *Crew*, not the agents. External mutation is detected (by the ref compare-and-swap), not prevented |
| Every agent works from an accurate picture | **NOT guaranteed.** Bulletins are delivered at a turn boundary, so awareness is eventual, not immediate |

The feature's real promise is therefore: **serialized, validated publication to a
shared branch, with teammates notified between turns.** That is worth building.
Claiming more would get someone to trust a green merge that is not green.

## Why hybrid

Three models were considered.

**A — conductor as a brain.** Its own CLI process reads session state and decides
who goes next in natural language. Handles unanticipated work, but makes *control
flow* nondeterministic — the one layer where that is intolerable. It is also
close to undebuggable: you cannot ask "which rule fired?", only "what was it
thinking?" Worse, deciding by reading transcripts means every decision re-reads a
growing pile of output, so cost grows superlinearly with session count.

**B — pure rules.** Predictable and free, and sufficient for routing. It fails at
the *payload*: when a builder finishes, the reviewer needs to know what changed
and why, not `exit 0`.

**C — hybrid (CHOSEN).** Deterministic routing, LLM-written briefings. Each
failure mode lands where it is cheap: a routing decision is **reproducible** (it
is unit-tested pure code), and a bad briefing is survivable. Cost is one small
run per edge traversed, not continuous supervision.

> **Correction from review.** Purity makes decisions *reproducible*, not
> *correct*. And deterministic routing does not make observations trustworthy,
> effects exclusive, or recovery safe. Those need their own mechanisms, specified
> below — they are the bulk of this document.

## Lanes and the integration owner

The design rests on one split:

> **Work happens in parallel. Publication happens one at a time.**

**A lane** is a unit of parallel work: one role, one git **worktree**, one
branch, one session *spawned in that worktree*. Because each lane is a separate
directory, two agents editing one working copy is structurally impossible.

**The integration owner** (previously "the baton") is a single-flight lock held
by the *conductor runtime*, not handed to an agent. While a lane is being
integrated, Crew will not begin integrating another. Ownership is acquired by
**compare-and-swap before any `await`**, and is released only after the git child
process has been confirmed dead.

### Why not a baton handed to agents

The original design told agents "you may rebase now". Review killed this:

- Nothing prevents an agent from running `git` when it does *not* hold the token,
  so the token was advisory while being described as a lock.
- A bulletin saying "rebase before you check in" instructs every other lane to
  run git *outside* the lock — the exact concurrency the lock exists to prevent.
- It put an LLM on the execution path: templating an instruction does not make
  its execution deterministic. The agent may ignore it, half-do it, or loop.

**So the conductor performs all integration git itself, in an integration
worktree it exclusively owns.** Agents commit to their own lane branch and are
never asked to rebase as a routine step. This is the single largest change from
the first draft.

What this buys:

- Two agents cannot edit the same working copy (separate worktrees).
- Two lanes cannot publish simultaneously (single-flight owner + ref CAS).
- A lane that publishes second is rebased onto the first one's work by Crew, so
  a textual conflict is caught before it lands, and goes back to the agent that
  wrote the code while it still has context.
- "What is this workspace doing?" always has an answer: N lanes working, ≤1
  publishing.

## Observation: what counts as "the agent is done"

This is the part the original draft got most wrong, and it is load-bearing:
everything downstream triggers off it.

**`detection.ts` does not emit a completion event.** It lives in `src/shared/`,
and emits `WAITING_INPUT` / `WAITING_APPROVAL` / `IDLE` state transitions
inferred from prompt regexes and silence. Neither agent preset defines an input
prompt regex; both fall back to `assumeWaitingAfterMs: 1500`.

A reviewer exercised the real detector. Observed behaviour:

| Situation | Detector says |
|---|---|
| Agent prints "Running a slow tool…" then is silent while it runs | `WAITING_INPUT` |
| Output contains a quoted "Do you want…" in a test fixture | `WAITING_APPROVAL` |
| Input sent, no output for a minute | stays `WORKING` |
| Answer complete, terminal keeps redrawing a footer | stays `WORKING` |
| Human types an unsubmitted draft, terminal echoes it | eventually `WAITING_INPUT` |

These are correct compromises for a notification dot. They are **not** safe
triggers for mutating a repository.

### The rule

> **Detector state is advisory. It may suggest a lane is ready. It may never, on
> its own, authorise a git mutation or a dispatch.**

v1 resolves this by not depending on it (see Phasing): **integration is triggered
by the human pressing a button**, and the detector only decorates the UI.

v2 introduces an explicit completion signal per preset, behind an
`AgentTransport` contract:

```ts
export interface AgentTransport {
  /** Is the session at a prompt and safe to write to? */
  readiness(sessionId: string): Promise<'ready' | 'busy' | 'unknown'>
  /** Deliver text; resolves only when submission is confirmed. */
  deliver(sessionId: string, text: string, opts: { deadlineMs: number }):
    Promise<{ delivered: true; id: string } | { delivered: false; reason: string }>
  /** A completed unit of work, with the identity of what was produced. */
  onWorkResult(cb: (r: WorkResult) => void): () => void
  cancel(sessionId: string): Promise<void>
}

export interface WorkResult {
  sessionId: string
  /** Deduplicates redraw-induced duplicate turns. */
  workItemId: string
  outcome: 'completed' | 'needs-changes' | 'blocked'
  /** The exact commit the agent says it produced, if any. */
  commit: string | null
}
```

A preset without a real transport implementation gets `'unknown'` readiness and
**manual confirmation only**. Automation is never silently extended to a CLI
whose boundaries Crew cannot observe.

### Delivery is not fire-and-forget

`SessionManager.input()` writes raw bytes, wakes a sleeping session, and returns
nothing useful. It does not wait for CLI readiness, does not frame messages, does
not acknowledge, and swallows write errors while still notifying the detector.
Its own comment says the wake-triggering keystroke is dropped.

Consequences that must be designed against, not assumed away:

- Text can land in an approval dialog. **A trailing newline then approves it.**
- Text can interleave with a human's unsubmitted draft and submit it.
- Text can be written into a TUI that has not drawn its prompt, and vanish.

So: the conductor **never** writes to a session whose readiness is not `ready`;
it queues instead. It never writes while the detector reports
`WAITING_APPROVAL`. And a per-session **input lock** prevents the conductor and
the renderer writing concurrently. A human typing takes the lock and *pauses*
automation for that session rather than counting as "another participant".

## How agents talk to each other

Every exchange is conductor-mediated. Crew is always in the middle — that is what
makes it observable and testable.

### 1. Work-result handoff (directed)

When work moves from role A to role B, B receives a report authored by A's
side of the system, carrying **verified facts** rather than prose alone:

- the work item id and the **exact commit** being handed over
- outcome: `completed` / `needs-changes` / `blocked`
- the diff stat and test result for that exact commit
- an LLM-written summary of intent and changed contracts (the one LLM call)
- outstanding questions

B must be **synchronised to that commit** before it is asked to review it —
otherwise it reviews whatever happens to be in its worktree. Review results are
invalidated if the artifact changes underneath them.

### 2. Bulletin (broadcast, on publication)

When a lane lands work, every other active lane is told — deterministically, no
LLM:

> **Lane `reviewer` landed `a1b2c3d`:** "Fix pagination off-by-one".
> Touched `src/list.ts`, `test/list.test.ts`.
> Your branch is now 1 commit behind; Crew will rebase it before your next
> publication.

Note what changed: the bulletin is **status, not an instruction to run git**.
Bulletins are coalesced to one merged message per lane per turn boundary.

**Bulletins are eventual.** An agent mid-turn learns at the end of that turn.
The original draft claimed adaptation *during* a turn in one paragraph and
end-of-turn delivery in the next; the latter is what is implementable.

### 3. Question relay — Phase 3

Deferred, and deliberately kept out of the v1 event model. It depends on agents
emitting a marker reliably; a PTY stream contains echoed input, quoted examples
and tool output, so marker-scanning produces false asks. "A missed marker
degrades to nothing, so the agent proceeds on its own assumption" is not a safe
coordination contract for anything load-bearing.

### What is deliberately absent

No shared scratchpad file, no agents writing to each other's directories, no
agent invoking another agent.

## Existing machinery this builds on

Corrected against the source after review. The original table's claims were
wrong in three places.

| Need | Reality in Crew today |
|---|---|
| "a session finished its turn" | **Does not exist.** `src/shared/detection.ts` emits `WAITING_*` / `IDLE` inferred from regex and 1.5s silence. Advisory only |
| deliver work to a session | `SessionManager.input(id, data)` writes bytes and wakes a sleeping session. **No readiness, framing, ack, or error surfacing** |
| run a one-shot LLM | `agent-runner.ts` — spawns `copilot -p` / `claude -p`, 180s timeout, 200k **output-retention** cap. *Not* a token or spend cap. Read-only is a property of the `Agent` passed (`writes: false`), not of the runner |
| workspace membership | `shared/workspaces.ts` — first-class `Workspace` ids, `sessionInWorkspaceId`. Accurate |
| per-window view state | `window-scope.ts` / `readViewPref`. Accurate, and the basis of the exclusivity argument |
| git subprocess pattern | **`src/main/tracker.ts`** already runs `git log/status/rev-parse/rev-list` with `execFile`, a 5s timeout and `SIGKILL`. This is the pattern to copy — not `github.ts`, which only resolves remote URLs |
| autonomy state | `autopilot.ts` polls permission mode. **Observation, not an interlock**, and when it is true the agent is *least* likely to produce a clean boundary |

`src/main/session-manager.ts` sets a session's `cwd` at spawn and uses it in
`identityKey(presetId, cwd)`. **There is no `setCwd`; cwd is part of session
identity.** An existing session therefore *cannot* be moved into a lane
worktree — lane sessions must be **spawned in** the worktree. This invalidates
the original draft's assumption that toggling `conducted` adopts existing
sessions in place.

The genuinely new machinery is **git lane and publication management**, which
Crew does not have. It is the largest piece of work in this spec — larger than
the router.

## Data model

```ts
// shared/types.ts
export interface Workspace {
  id: string
  name: string
  description?: string
  order: number
  createdAt: number
  conducted?: boolean
  /** Static configuration. Never mutated by a run. */
  pipeline?: Pipeline
}

export type RoleId = string
export type LaneId = string

export interface Role {
  id: RoleId
  name: string
  /** The session spawned for this role, in its lane worktree. */
  sessionId: string | null
  order: number
}

export interface Lane {
  id: LaneId
  role: RoleId
  worktree: string
  branch: string
  status: 'working' | 'ready' | 'publishing' | 'blocked' | 'done'
}

export interface Edge { from: RoleId; to: RoleId | 'done'; gate: GateId }
export type GateId = 'always' | 'has-commits' | 'tests-pass'

/** Static config: roles, edges, branch, limits, test recipe. */
export interface Pipeline {
  roles: Role[]
  edges: Edge[]
  integrationBranch: string
  /** Crew-owned worktree that is the ONLY checkout of integrationBranch. */
  integrationWorktree: string
  test: TestRecipe | null
  limits: Limits
}

export interface TestRecipe {
  command: string
  args: string[]
  cwd: string          // relative to the worktree root
  timeoutMs: number
}

export interface Limits {
  maxHandoffs: number
  maxEdgeTraversals: number
  maxLanes: number           // default 2
  /** Every autonomous dispatch, not just handoffs. */
  maxDispatches: number
  /** Wall-clock ceiling for the whole run. */
  runDeadlineMs: number
  /** Per-lane repair attempts before the lane is blocked. */
  maxRepairAttempts: number
}

/** Mutable run state, persisted separately from config. */
export interface Run {
  id: string
  pipelineOf: string          // workspace id
  lanes: Lane[]
  /** Single-flight publication owner. */
  publishing: LaneId | null
  /** Lanes awaiting publication. Explicit — the waiter must be wakeable. */
  ready: LaneId[]
  handoffs: number
  dispatches: number
  edgeTraversals: Record<string, number>
  startedAt: number
  /** Durable record of in-flight effects. See Durability. */
  journal: JournalEntry[]
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'needs-recovery'
}
```

Separating `Pipeline` (config) from `Run` (state) is a review requirement: the
original put counters in one structure and persisted another, so restart could
not explain what had happened.

## The router

The routing engine is a pure function. **It recommends; it does not grant.**

```ts
// shared/conductor-route.ts
export function route(state: ConductorState, event: ConductorEvent): Decision

export type Decision =
  | { kind: 'handoff'; from: RoleId; to: RoleId; workItemId: string; reason: string }
  | { kind: 'recommend-publish'; lane: LaneId; reason: string }
  | { kind: 'hold'; lane: LaneId; reason: string }
  | { kind: 'block'; lane: LaneId; reason: string }
  | { kind: 'stop'; reason: string }
```

`recommend-publish` is a *recommendation*. The runtime acquires the single-flight
lock by compare-and-swap; if the CAS fails, the lane goes to the `ready` set. The
original draft had `route()` read `integrating: null` and return a grant — two
concurrent events could both observe `null` across an `await` and both act.
**Main-thread JavaScript does not serialise across `await`.**

`require-rebase` is gone: Crew rebases, agents do not.

**No IO inside `route()`.** Facts are gathered first and passed as a snapshot —
and are **revalidated at act time**, because gathering is async and the tree can
change underneath a decision:

```ts
export interface Facts {
  /** Commits on the lane branch not on the pinned base. Replaces diffLines. */
  ahead: number
  /** Uncommitted changes present (staged, unstaged or untracked). */
  dirty: boolean
  behind: number
  /** SHA of the lane branch tip these facts describe. */
  laneTip: string
  /** SHA of integrationBranch these facts were computed against. */
  baseSha: string
  testsExitCode: number | null
  /** Which recipe produced testsExitCode, so stale results are detectable. */
  testedTip: string | null
}
```

`diffLines` from `git diff --numstat` is removed. Review found it measured the
wrong thing in both directions: it omits staged, untracked and already-committed
work, and has no line counts for binaries. A lane that committed its work (clean
tree) scored zero and would hold forever; a lane that had not committed scored
nonzero and would "publish" nothing.

```ts
export interface ConductorEvent {
  kind: 'work-result' | 'publication-settled' | 'lock-released' | 'deadline'
  role: RoleId
  lane: LaneId
  workItemId: string
  facts: Facts
}

export interface ConductorState {
  pipeline: Pipeline
  run: Run
  sessionStatus: Record<RoleId, 'ready' | 'busy' | 'asleep' | 'exited' | 'unassigned'>
}
```

`sessionStatus` now distinguishes `ready` from `busy`: the original enum could
not express "the target is alive but mid-turn", so a handoff could be delivered
into an agent that was working.

**Gates:**

| Gate | Passes when |
|---|---|
| `always` | unconditionally — an ungated transition, *not* permission to ignore a blocked lane |
| `has-commits` | `ahead > 0 && !dirty` |
| `tests-pass` | `testsExitCode === 0 && testedTip === laneTip` |

`tests-pass` is only evaluated inside the publication transaction, never as a
routing gate on every turn. Running a suite to decide routing is what races
ports and caches between lanes.

### Decision table

| Situation | Decision |
|---|---|
| work result, gate passes, lock free | `recommend-publish` (runtime CAS decides) |
| work result, gate passes, lock held | `hold` + **lane enters `ready`** |
| gate fails because the lane is dirty | `block` — "commit your work"; the agent is told |
| gate fails on tests | `block` with the failing gate named |
| no test recipe configured but gate needs one | `block` naming the missing recipe — never a silent hold |
| `lock-released` and `ready` is non-empty | `recommend-publish` for the head of `ready` (FIFO) |
| publication settled, onward edge exists, target `ready` | `handoff` |
| publication settled, onward edge exists, target `busy` | `hold`; queue the work item |
| publication settled, edge target is `done` | lane `done`; run stops only when **all** lanes are done |
| any limit exceeded (`maxDispatches`, `runDeadlineMs`, …) | `stop` |
| event whose `laneTip` no longer matches | `hold` (stale event, dropped) |

Two corrections from review are encoded here. First, a `hold` now **always**
either enters the `ready` set or blocks with a stated reason — the original had
holds that nothing could ever wake. Second, one lane reaching `done` no longer
stops the run while others are still working.

> The claim "there is no scheduler to deadlock" was wrong. An event-driven
> dispatcher with a ready set **is** a scheduler. It is specified as one, with
> FIFO fairness, rather than pretended away.

## The conductor runtime

`src/main/conductor.ts` — owns the loop, the lock, and all IO.

Structured as `reduce(state, event) → { nextState, effects }`, with the runtime
executing effects and feeding their settlement back in as events. Every effect
has a defined success, failure, cancellation and timeout path.

On a work result for a conducted session:

1. **Gather facts** — via the `tracker.ts` pattern: `execFile`, short timeout,
   `SIGKILL`, in-flight dedup. **No TTL cache.** `github.ts` caches for 30s
   because a remote URL never changes; `ahead`/`behind`/`dirty` change
   constantly, and a cached gate failure is a permanent stall.
2. **Call `route()`** — pure, instant.
3. **Acquire the lock by CAS** if publishing, then **revalidate facts** against
   the live refs before mutating anything.
4. **Execute the effect**, journalling intent first (below).
5. **Log the decision** to a bounded decision log the UI renders.

### The publication transaction

Runs in the **integration worktree**, which Crew exclusively owns and which is
the only checkout of `integrationBranch`. This is a hard requirement: git refuses
to check out one branch in two worktrees, and a fast-forward into a branch that
is checked out in the user's own clone either fails or silently desynchronises
the user's working copy from the ref.

All git runs with `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`,
`GIT_SEQUENCE_EDITOR=true`. An editor or credential prompt with no TTY hangs
until the timeout, which is precisely the lost-lock failure.

1. **Precondition:** lane is clean and `ahead > 0`. If dirty, the lane is
   blocked and its agent is asked to commit. **Crew never runs `git add -A` on an
   agent's behalf** — it cannot know what belongs in the commit.
2. **Pin the base.** Record `baseSha = rev-parse integrationBranch`.
3. **Freeze the candidate.** Record `laneTip`. The candidate is that SHA, not
   "whatever the branch points at later".
4. **Rebase** the candidate onto `baseSha` in the integration worktree.
   On conflict: abort the rebase, release the lock, mark the lane `blocked`, and
   send the conflicting paths back to the lane's own agent. The lock is never
   held across a conflict.
5. **Test** the rebased candidate with the recipe. Record `testedTip`.
   On failure: same treatment as a conflict.
6. **Publish by compare-and-swap:** `update-ref integrationBranch <new> <baseSha>`.
   If the old value no longer matches, someone mutated the branch externally —
   abort, surface it, do not retry blindly.
7. **Record completion in the journal before any dependent effect.**
8. **Bulletin** every other active lane.
9. **Release the lock** — only after the git child is confirmed exited — and emit
   `lock-released`, which wakes the head of `ready`.

**The lock is released on every exit path**, and release is structured so that a
timeout **kills the process group and reaps it before** clearing ownership. A
timeout that clears ownership while `git rebase` is still running is a
double-grant, not a recovery — the next lane then meets `index.lock` or a moving
ref.

### Durability and recovery

`finally` does not run when the process is killed. Electron apps get quit.

**Journal intent before every effect**, including operation id, lane, phase,
`baseSha`, `laneTip`, and expected resulting ref. The store's workspace save does
not currently acknowledge durability — persistence failure must **fail closed**
and prevent the effect, rather than reporting success from memory.

On launch, a run never auto-resumes. It enters `needs-recovery` and reconciles
the journal against reality:

| Journal says | On-disk reality | Classification |
|---|---|---|
| intent recorded, no completion | refs unchanged, no rebase metadata | **not started** — safe to redo |
| intent recorded, no completion | `rebase-merge/` present in the integration worktree | **interrupted** — offer continue or abort; never silently restart |
| intent recorded, no completion | ref already equals the expected SHA | **committed but unrecorded** — record it, do not republish |
| any | ref differs from both old and expected | **externally modified** — stop, surface, require human |
| delivery journalled, no ack | — | **delivery unknown** — never assume received |

Only after reconciliation may the user press Step or Resume. "Cleared lock
field" is never evidence that the last operation failed.

### Bounds on autonomy

The original bounded handoffs and edge traversals. Review found the unbounded
loop that skips both: *work result → repair instruction → agent responds without
fixing it → work result → repair instruction → …* No edge is traversed, so no
counter moves.

So: **every autonomous dispatch is counted** — briefings, bulletins that expect a
response, repairs, retries. Plus a wall-clock `runDeadlineMs`, a
`maxRepairAttempts` per lane, and no-progress detection (a repair that does not
change `laneTip` is not progress).

Spend is reported as an **estimate**, explicitly: `agent-runner`'s 200k cap is
output retention, not tokens; `shared/cost.ts` parses printed figures and reads
zero when nothing is printed. Neither can enforce a dollar ceiling. Time and
attempt limits are the real enforcement.

**Pause** stops new dispatches. **Stop** additionally cancels running children,
waits for confirmed exit, and fences publication so a late-completing effect
cannot land after the user stopped the run.

### The briefing (the only LLM call)

One headless `agent-runner` run, **explicitly `writes: false`**, in the outgoing
lane's worktree. Read-only is a property of the `Agent` passed, not of the
runner, so it must be set deliberately.

Context: role names, task, the frozen candidate SHA, its diff stat and test
result, and a transcript tail. The transcript and diff are **untrusted input** —
a prompt-injection path into the next privileged agent — and are fenced and
labelled as data.

If the run fails, fall back to the templated report. The verified facts travel
regardless; only the prose is lost. Liveness never depends on an LLM call.

## The lane manager

`src/main/lanes.ts` — isolated behind a narrow interface so the conductor never
shells out to git itself.

```ts
export interface LaneManager {
  create(repo: string, branch: string): Promise<Lane>
  facts(lane: Lane, base: string): Promise<Facts>
  rebaseInIntegration(candidate: string, base: string): Promise<RebaseResult>
  publish(newSha: string, expectedOld: string): Promise<PublishResult>
  destroy(lane: Lane, opts: { force: boolean }): Promise<void>
}

export type RebaseResult =
  | { ok: true; resultSha: string }
  | { ok: false; conflictPaths: string[]; message: string }

export type PublishResult =
  | { ok: true; commit: string; touchedPaths: string[] }
  | { ok: false; reason: 'ref-moved' | 'error'; message: string }
```

Rules:

- Worktrees live under a Crew-managed directory and are git-ignored.
- **Dependency sharing is project-specific and off by default.** The original
  draft made a `node_modules` symlink a universal invariant, copied from this
  repo's own worktree habit. That is wrong for non-Node repos, wrong when
  branches differ in dependencies, and actively harmful: one lane's install
  mutates the tree another lane is testing against.
- `destroy` refuses to remove a worktree with uncommitted changes unless forced,
  and a refused destroy **must not** leave the run holding the lock.
- Lane teardown quiesces the lane's agent first; it never races a live git child.

## Exclusivity

A session may belong to many workspaces but **at most one conducted** workspace.

The "only one workspace is open at a time" intuition does **not** hold:
`activeWorkspace` is a *per-window* view preference (`readViewPref`, namespaced
by window slot in `window-scope.ts`), so two windows can have two workspaces
active at once; and conducting must survive switching away. **"Active" (view) and
"conducting" (runtime) are decoupled**, so exclusivity is enforced on membership
data.

```ts
// shared/conductor-membership.ts — pure
export function canConduct(
  workspaces: readonly Workspace[],
  sessions: readonly SessionInfo[],
  wsId: string
): { ok: true } | { ok: false; conflicts: Conflict[] }
```

Additional requirements from review:

- Enforcement must be a **single transactional validator in the main process**
  covering *every* membership mutation path — `set`, `add`, `remove`, `move`,
  `archive` — not only the toggle.
- **All member sessions must resolve to the same repository**, or the toggle
  fails: `LaneManager.create` has no repo to act on otherwise.
- At most one session per role, and one active lane per role.
- The store validator must **fail closed** on a malformed `Run`. It currently
  accepts unknown workspace fields, so a corrupt run would otherwise load and be
  conducted.

## UI

- **Workspace editor:** a `Conducted` toggle; role list; per-edge gate; the
  integration branch; the test recipe (command, args, cwd, timeout) as explicit
  user-confirmed fields. Rejected toggles show the conflict inline.
- **Roster:** lane status and commits-behind per lane. `behind` is derived from
  `rev-list` only — never incremented by bulletins, which would give the UI and
  the router two disagreeing sources.
- **Conductor panel:** the decision log, plus **Pause**, **Step**, **Stop**, and
  — when `needs-recovery` — the reconciliation report with explicit
  continue/abort choices per interrupted operation.

Step permits exactly one decision; follow-up events queue until the next Step.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| target session exited | `stop` with a reason; notify |
| target session asleep | queue; deliver only once readiness is `ready` |
| target session busy | queue the work item; do not interrupt |
| detector reports `WAITING_APPROVAL` | never write; an injected newline would approve it |
| human types into a conducted session | human takes the input lock; automation pauses for that session |
| briefing run fails | templated report; verified facts still travel |
| test recipe missing but required | lane `block`ed naming the missing recipe |
| lane is dirty at publication | `block`; agent asked to commit; Crew never stages |
| rebase conflict | abort rebase, release lock, lane `blocked`, paths returned to the agent |
| tests fail | same as conflict |
| `update-ref` CAS fails | external mutation — stop and surface; never blind retry |
| publication times out | kill process group, **confirm exit**, then release lock; journal `interrupted` |
| Crew quits mid-publication | run enters `needs-recovery`; reconcile journal vs refs before any Step |
| two lanes ready at once | one publishes, the other enters `ready`; woken by `lock-released` |
| publication fails | `lock-released` is still emitted — the waiter must never starve on a failure path |
| lane teardown refused (dirty) | lane retained and shown; lock never leaked |
| a lane finishes while others work | that lane is `done`; the run continues |

## Testing

Seams, all injectable: **clock, AgentTransport, LaneManager/facts provider,
TestRunner, RunStore, process supervisor, BriefingService.**

- **Unit (`conductor-route.ts`):** the decision table exhaustively — both-ready,
  stale-event, dirty-lane, missing-recipe, limit-exceeded, one-lane-done.
- **Unit (`conductor-membership.ts`):** exclusivity, multi-window, mixed-repo
  rejection, every mutation path.
- **Lane manager, against a real temporary git repo:** create/rebase/publish/
  destroy, a deliberate conflict, CAS rejection when the ref moved, refusal to
  destroy dirty, non-interactive env. Real git is required — rebase metadata and
  ref semantics cannot be faked credibly.
- **Runtime, adversarial:** concurrent CAS attempts; publication failure wakes
  the waiter; crash immediately before and after `update-ref`; restart with
  `rebase-merge/` present; store write failure before an effect; duplicate and
  late events after pause/stop/removal; retry exhaustion with zero handoffs;
  delivery into a busy session; the five detector traces above.
- **E2E:** two fake-CLI lanes touching one file. Assert concurrent work,
  serialized publication, the second lane rebased onto the first, the bulletin
  naming the first's commit, both commits on the integration branch, the user's
  own checkout untouched, and a clean recovery from a simulated mid-publication
  kill.

## Non-goals (v1)

- The conductor opening PRs or merging to `main`.
- Preventing agents from running git themselves. Crew serializes **its own**
  publications and detects external mutation; it is not a sandbox.
- Semantic conflict detection beyond the test command.
- Agent-to-agent messaging without Crew in the middle.
- Cross-workspace or cross-repository conducting.
- Conflict *resolution* by the conductor.

## Phasing

All three reviews independently concluded the original Phase 1 — toggle, roles,
worktrees, router, baton, briefings, bulletins, decision log, pause/step,
exclusivity — was the whole product, built on git machinery that does not exist
and a turn boundary that is not trustworthy. Re-phased so each layer ships on top
of something already watched working:

**Phase 1 — the publication mutex, manually triggered.** One repo, validated.
Lane worktrees on their own branches; a dedicated integration worktree; the
user's checkout never a merge target. At most two lanes. Single-flight lock,
CAS publication, journal and recovery, non-interactive git, process-group kill.
The UI shows ahead/behind/dirty per lane and a **Publish this lane** button.

No PTY injection, no LLM briefings, no bulletins that instruct git, no question
relay, no detector-triggered automation. This is the part that can corrupt a
production repo, and it is fully testable against a temp git repo with no agent
in the loop.

**Phase 2 — automation.** The `AgentTransport` contract with a real completion
signal per preset, readiness-gated delivery, the input lock, work-result
handoffs, bulletins, the dispatcher and ready set, autonomy bounds.

**Phase 3 — briefings and relay.** The LLM briefing on handoff; then the question
relay with request ids, correlation and expiry.

**Phase 4 — gated auto-merge**, once the coordination has been watched working.

## Resolved review questions

1. **`maxLanes` default: 2**, three opt-in. Two exposes every concurrency and
   integration problem and supports builder/reviewer. Limits on stored worktrees,
   active agents, briefing runs and test processes are separate counters.
2. **Gates:** three are enough, but `diff-nonempty` is replaced by
   `has-commits` (`ahead > 0 && !dirty`), and `tests-pass` is evaluated only
   inside the publication transaction. A reviewer's `needs-changes` outcome
   blocks a transition even when tests pass — approval is never inferred from
   quiescence.
3. **Test command:** an explicit, user-confirmed per-workspace `TestRecipe`,
   executed with `execFile` and no shell. `package.json` scripts may be
   *suggested*, never silently executed: they are arbitrary code, monorepos have
   several, and not every repo is Node. Missing recipe is a visible `block`.
4. **Restart:** never auto-resume — but **reconciliation must precede Step or
   Resume**. Persist counters, phases, ref identities and pending deliveries. A
   stopped app is not evidence its last operation failed.
5. **Question relay:** Phase 3, and kept out of the v1 event model entirely.

## Open question for the user

**Phase 1 as re-scoped has no agent automation in it** — it is the git safety
layer with a manual button. That is what all three reviewers recommended
shipping first. If the priority is instead to *see agents coordinating* sooner,
the alternative is to build Phase 2's transport for one preset only (Claude
Code, which has the richest structured output) and accept manual publication
for longer. Which ordering do you want?
