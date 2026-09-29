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
| Textually conflicting check-ins are caught before landing | **Guaranteed** — publication merges onto the pinned base in a worktree Crew owns, or fails |
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
- A lane that publishes second is merged onto the first one's work by Crew, so
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
> Your branch is now 1 commit behind. Sync your lane to pick it up.

Note what changed: the bulletin is **status, not an instruction to run git**,
and it does not promise that Crew will merge their work into your lane — Crew
only ever moves the integration ref. Picking up a teammate's work is an explicit
Sync.
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
  order: number
  /** Authors commit; reviewers judge somebody else's commits and own no
   *  branch. See "Review gates publication". */
  kind: 'author' | 'reviewer'
}

export interface Lane {
  id: LaneId
  role: RoleId
  /** Which agent, and which mind, runs this lane. See "Which agent runs a
   *  lane". Captured per lane because cross-model review is the main reason
   *  to run more than one. */
  agent: LaneAgent
  worktree: string
  /** null for a reviewer lane: it owns no branch. Its worktree is detached
   *  at the candidate under review. */
  branch: string | null
  status: 'working' | 'reviewing' | 'ready' | 'publishing' | 'blocked' | 'done'
}

export interface LaneAgent {
  /** A Crew preset id: 'copilot-cli' | 'claude-code' | 'shell'. */
  presetId: string
  /** Copilot CLI only. An id from the CLI's own catalogue, or null to take
   *  the CLI default. Never a hardcoded list — see listCopilotModels(). */
  model: string | null
}

export interface Edge { from: RoleId; to: RoleId | 'done'; gate: GateId }
export type GateId = 'always' | 'has-commits' | 'tests-pass' | 'review-approved'

/** A frozen candidate awaiting a verdict. Keyed by SHA, never by lane, so a
 *  verdict can never be applied to code the reviewer did not see. */
export interface Review {
  laneId: LaneId
  reviewerLaneId: LaneId
  /** The exact commit the reviewer was given. */
  candidateSha: string
  verdict: 'pending' | 'approved' | 'needs-changes'
  /** Wall-clock deadline. On expiry the lane blocks with a stated reason
   *  rather than waiting forever. */
  deadlineAt: number
}

/** Static config: roles, edges, branch, limits, test recipe. */
export interface Pipeline {
  roles: Role[]
  edges: Edge[]
  integrationBranch: string
  /** Crew-owned worktree, permanently DETACHED. integrationBranch is
   *  deliberately checked out nowhere. */
  integrationWorktree: string
  test: TestRecipe | null
  limits: Limits
}

export interface TestRecipe {
  /** Run once per integration worktree, keyed on a hash of the lockfile.
   *  Without this the integration worktree has no dependencies installed and
   *  every `tests-pass` fails on a Node repo. */
  setup?: { command: string; args: string[]; timeoutMs: number }
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
  /** The pipeline as it was when the run started. Config edits during a run
   *  would otherwise make a journal entry reference a branch or role that no
   *  longer exists, and reconcile against the wrong ref. */
  pipelineSnapshot: Pipeline
  lanes: Lane[]
  /** Which session fills which role, for THIS run. Runtime state does not
   *  belong on Role, which is config. */
  assignment: Record<RoleId, string>
  /** Single-flight publication owner. */
  publishing: LaneId | null
  /** Lanes awaiting publication. The single source of queue position. */
  ready: LaneId[]
  /** Work items parked against a busy target, drained by readiness-changed. */
  parked: Array<{ to: RoleId; workItemId: string }>
  handoffs: number
  dispatches: number
  edgeTraversals: Record<string, number>
  startedAt: number
  state: 'idle' | 'running' | 'paused' | 'stopped' | 'needs-recovery'
}
```

Separating `Pipeline` (config) from `Run` (state) is a review requirement: the
original put counters in one structure and persisted another, so restart could
not explain what had happened. Two consequences follow, and both are rules:

- **A run snapshots its pipeline at start**, and pipeline edits are rejected
  while the run is not `idle` or `stopped`. `Role.sessionId` moved to
  `Run.assignment` for the same reason — it was runtime state living in a
  structure documented as never mutated by a run.
- **The journal is not part of `Run` and not in the main store.** `store.ts`
  quarantines the entire file on corruption, and a per-effect append is the
  most frequently written and most corruption-exposed data here. It gets its
  own bounded file, written with the existing durable-write pattern
  (`mutateCustomViewsDurably`). A damaged journal must not cost the user their
  sessions, layouts and workspaces.

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

`require-rebase` is gone: Crew integrates; agents are never asked to run git as
a routine step of the pipeline.

**No IO inside `route()`.** Facts are gathered first and passed as a snapshot —
and are **revalidated at act time**, because gathering is async and the tree can
change underneath a decision:

```ts
export interface Facts {
  /** Commits on the lane branch not on the pinned base. Replaces diffLines. */
  ahead: number
  /** Tracked modifications only. Advisory — publication works on a frozen
   *  commit, so this warns, it does not gate. */
  dirtyTracked: boolean
  /** Untracked files present. Purely informational. */
  untracked: boolean
  behind: number
  /** SHA of the lane branch tip these facts describe. */
  laneTip: string
  /** SHA of integrationBranch these facts were computed against. */
  baseSha: string
  testsExitCode: number | null
  /** Which candidate produced testsExitCode, so stale results are detectable. */
  testedTip: string | null
}
```

`diffLines` from `git diff --numstat` is removed. Review found it measured the
wrong thing in both directions: it omits staged, untracked and already-committed
work, and has no line counts for binaries. A lane that committed its work (clean
tree) scored zero and would hold forever; a lane that had not committed scored
nonzero and would "publish" nothing.

`dirty` was then split and demoted. Publication freezes a commit, so an
uncommitted tree cannot contaminate it; blocking on a boolean that includes
untracked files would stall a lane permanently on `coverage/`, `.DS_Store`, or
notes an agent left itself.

```ts
export interface ConductorEvent {
  kind: 'work-result' | 'publication-settled' | 'lock-released'
      | 'readiness-changed' | 'deadline' | 'verdict'
  role: RoleId
  lane: LaneId
  /** Present only on 'work-result'. Crew mints it when it dispatches work and
   *  matches the result back to that outstanding dispatch — no CLI emits one,
   *  and an id minted per detected turn would change on every screen redraw
   *  and so deduplicate nothing. */
  workItemId?: string
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
into an agent that was working. `readiness-changed` is what drains the queue of
work items parked for a busy target — without it, "queue the work item" was
another hold that nothing could wake.

**Gates:**

| Gate | Passes when |
|---|---|
| `always` | unconditionally — an ungated transition, *not* permission to ignore a blocked lane |
| `has-commits` | `ahead > 0` |
| `tests-pass` | `testsExitCode === 0 && testedTip === laneTip` |

`tests-pass` is only evaluated inside the publication transaction, never as a
routing gate on every turn. Running a suite to decide routing is what races
ports and caches between lanes.

### Decision table

| Situation | Decision |
|---|---|
| work result, author lane, onward edge to a **reviewer** | freeze `candidateSha`, `handoff` to the reviewer, lane → `reviewing` |
| verdict `approved`, `candidateSha === laneTip` | treat as a work result: evaluate gates, then queue or publish |
| verdict `approved`, `candidateSha !== laneTip` | discard (stale — the author moved); re-freeze and review again |
| verdict `needs-changes` | deliver to the author, lane → `working`; counts against `maxDispatches` |
| `Review.deadlineAt` elapsed | `block` naming the unanswered review — never a silent hold |
| work result, gate passes, lock free, **`ready` empty** | `recommend-publish` (runtime CAS decides) |
| work result, gate passes, lock free, **`ready` non-empty** | `hold` + lane joins the **tail** of `ready` |
| work result, gate passes, lock held | `hold` + lane joins the tail of `ready` |
| `ahead == 0` (nothing to publish) | `hold` — idle, not an error |
| gate fails on tests | `block` with the failing gate named |
| no test recipe configured but gate needs one | `block` naming the missing recipe — never a silent hold |
| `lock-released` (success **or** failure) | dequeue the head of `ready` → `recommend-publish` |
| `readiness-changed` to `ready` with a parked work item | deliver it |
| lane `blocked`, a later work result changes `laneTip` | leave `blocked`, re-evaluate |
| publication settled, onward edge exists, target `ready` | `handoff` |
| publication settled, onward edge exists, target `busy` | `hold`; park the item until `readiness-changed` |
| publication settled, edge target is `done` | lane `done`; run stops only when **all** lanes are done |
| any limit exceeded (`maxDispatches`, `runDeadlineMs`, …) | `stop` |
| event whose `laneTip` no longer matches | `hold` (stale event, dropped) |

Note that **no review row touches the lock.** Review is entirely lock-free by
construction; a lane only contends for the lock once it holds an `approved`
verdict for its current tip. See "Review gates publication" for why holding the
lock across a review would serialise the whole workspace.

Three corrections are encoded here. First, every `hold` either joins `ready`,
parks against a `readiness-changed` event, or blocks with a stated reason — no
hold exists that nothing can wake. Second, one lane reaching `done` no longer
stops the run while others work. Third, **only `lock-released` dequeues**: a
lane that has just published must not race its own next candidate against a
waiting lane's wakeup and win the CAS repeatedly, starving it.

`Run.ready[]` is the single source of truth for queue position. `Lane.status`
renders it; it never independently decides it — the same rule applied to
`behind` below.

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

1. **Precondition:** `ahead > 0`. Untracked and unstaged files are **warned
   about, not blocking**: publication operates on a frozen commit, so a dirty
   working tree cannot leak into it, and blocking on `dirty` would stall
   indefinitely on `coverage/`, `.DS_Store` or an agent's scratch notes.
   **Crew never runs `git add -A` on an agent's behalf** — it cannot know what
   belongs in the commit.
2. **Pin the base.** Record `baseSha = rev-parse integrationBranch`.
3. **Freeze the candidate.** Record `laneTip`. The candidate is that SHA, not
   "whatever the branch points at later".
4. **Merge** the candidate into `baseSha` in the integration worktree, whose
   HEAD stays **detached** throughout (see below). Fast-forward when possible,
   otherwise a real merge commit. On conflict: abort the merge, release the
   lock, mark the lane `blocked`, and send the conflicting paths back to the
   lane's own agent. The lock is never held across a conflict.
5. **Test** the merge result with the recipe. Record `testedTip`.
   On failure: same treatment as a conflict.
6. **Journal `resultSha`** — a second write, after the merge result exists.
   Intent alone cannot be reconciled, because the resulting SHA is not knowable
   before step 4 runs.
7. **Check no worktree has the branch checked out** (`git worktree list
   --porcelain`). Refuse if one does.
8. **Publish by compare-and-swap:** `update-ref integrationBranch <resultSha> <baseSha>`.
   If the old value no longer matches, someone mutated the branch externally —
   abort, surface it, do not retry blindly.
9. **Record completion in the journal before any dependent effect.**
10. **Bulletin** every other active lane.
11. **Release the lock** — only after the git child is confirmed exited — and
    emit `lock-released`, which dequeues the head of `ready`.

### Why merge, not rebase

The previous draft rebased the candidate and published the rewritten commits.
That is broken, and it breaks on a lane's *second* publication:

- Rebasing rewrites the candidate into new SHAs, but **the lane branch still
  points at the originals**. `ahead` therefore never returns to 0, the lane
  stays eligible to publish with no new work, and the gate is permanently
  satisfied.
- On the next publication, `git rebase` drops commits whose patch-id already
  exists upstream — but once a teammate's change has altered the surrounding
  context lines, the patch-ids no longer match. The lane's already-landed
  commits get replayed on top of themselves and conflict, on every subsequent
  publication.

Merging makes the lane's commits **ancestors** of the integration branch, so
`ahead` resets by itself and no history is rewritten.

### Sync: how a lane receives its teammates' work

Merging into the integration branch does not put teammates' work into the
lane. Without a way back, a lane edits stale code indefinitely, `behind` grows
without bound, and semantic conflicts become the normal case rather than the
exception.

So there is an explicit **Sync lane** operation: merge `integrationBranch` into
the lane branch. It is a button in Phase 1, and it runs only when the lane is
quiescent. It is safe for an agent to run too — the publication CAS is what
protects the shared ref.

This retires the "agents never touch git" framing, which was an overcorrection.
The accurate rule is narrower and enforceable:

> **Only Crew moves the integration ref.** What an agent does on its own lane
> branch is its business.

### The integration worktree's HEAD

The integration worktree's HEAD is **permanently detached**, and
`integrationBranch` is deliberately **checked out nowhere**.

If HEAD sat on `integrationBranch`, `update-ref` would advance the ref while
leaving that worktree's index and files behind it — the same desynchronisation
that makes merging into the user's own checkout unsafe. And git only refuses a
checkout when another worktree holds the branch as HEAD, so leaving it checked
out nowhere is also what keeps the user free to check it out themselves without
colliding with a publication in flight. Hence the explicit `git worktree list`
check immediately before the CAS.

After publishing, the integration worktree is left detached at the new commit.

### The process supervisor

"Copy the `tracker.ts` pattern" is not sufficient here, and the spec previously
said it was. `tracker.ts` uses `execFile` with a timeout and `SIGKILL` but
**does not put the child in its own process group**, so a wedged `git` can leave
descendants running. `agent-runner.ts` does spawn `detached: true` and kills
with `process.kill(-pid)`, but it marks the run finished *before* the process
exits and then ignores the exit event — precisely the early release this design
forbids.

Neither existing pattern meets the requirement, so the lane manager needs a
small supervisor of its own: own process group, timeout, `SIGTERM` then
`SIGKILL`, and a promise that resolves **only on confirmed exit**. Ownership is
released after that promise settles, never before.

**The lock is released on every exit path.** A timeout that clears ownership
while `git merge` is still running is a double-grant, not a recovery — the next
lane then meets `index.lock` or a moving ref.

### Durability and recovery

`finally` does not run when the process is killed. Electron apps get quit.

**The journal is written twice per publication, not once.**

1. **Intent**, before anything runs: operation id, lane, phase, `baseSha`,
   `laneTip`.
2. **`resultSha`**, after the merge produces a commit but *before* the CAS.

One write is not enough, and the previous draft's "journal the expected
resulting ref before the effect" was impossible: the resulting SHA does not
exist until the merge has run. Without the second write there is nothing to
compare the ref against, so "committed but unrecorded" is unclassifiable — the
single most dangerous recovery state, because redoing it double-applies work.

Persistence failure must **fail closed** and prevent the effect, rather than
reporting success from memory as the current store save does.

On launch, a run never auto-resumes. It enters `needs-recovery` and reconciles
the journal against reality:

| Journal says | On-disk reality | Classification |
|---|---|---|
| intent, no `resultSha` | refs unchanged, no merge metadata | **not started** — safe to redo |
| intent, no `resultSha` | `MERGE_HEAD` present in the integration worktree | **interrupted** — offer continue or abort; never silently restart |
| `resultSha` recorded | ref still equals `baseSha` | **merged but unpublished** — safe to retry the CAS |
| `resultSha` recorded | ref equals `resultSha` | **published but unrecorded** — record it and send the bulletin; never republish |
| `resultSha` recorded, no bulletin | ref equals `resultSha` | **published, teammates uninformed** — send the bulletin |
| any | ref differs from both `baseSha` and `resultSha` | **externally modified** — stop, surface, require human |
| test phase journalled | integration worktree dirty, test processes possibly orphaned | **interrupted tests** — reset the worktree to `baseSha`, reap strays, redo |
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
  /** Merge the frozen candidate into the base, in the detached integration
   *  worktree. Never rebases: rewriting history strands the lane branch. */
  mergeInIntegration(candidate: string, base: string): Promise<MergeResult>
  /** Bring the integration branch INTO a lane. The only way a lane receives
   *  its teammates' work. Runs only when the lane is quiescent. */
  syncLane(lane: Lane, base: string): Promise<MergeResult>
  /** Compare-and-swap the integration ref. Refuses if any worktree has the
   *  branch checked out. */
  publish(newSha: string, expectedOld: string): Promise<PublishResult>
  destroy(lane: Lane, opts: { force: boolean }): Promise<void>
}

export type MergeResult =
  | { ok: true; resultSha: string; fastForward: boolean }
  | { ok: false; conflictPaths: string[]; message: string }

export type PublishResult =
  | { ok: true; commit: string; touchedPaths: string[] }
  | { ok: false; reason: 'ref-moved' | 'branch-checked-out' | 'error'; message: string }
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

## What a conducted workspace does to its members

The adoption model is gone, and this needs stating plainly because two
requirements below are leftovers of it.

`session-manager.ts` sets `cwd` at spawn and uses `identityKey(presetId, cwd)`.
There is no `setCwd`. **An existing session cannot be relocated into a lane
worktree.** So:

- Conducting a workspace does **not** convert its existing member sessions into
  lanes. They stay exactly as they are, in their own directories, unconducted.
- A lane is created by **spawning a new session** in a freshly created worktree.
  Lanes are additive.
- **The repository comes from the workspace's conductor settings**, chosen once
  when the toggle is switched on — not inferred from member sessions, which may
  legitimately be scattered across directories.

Exclusivity therefore constrains *lane* sessions, which Crew created and owns.

## Which agent runs a lane

The original sketch fanned out to three different CLIs — Claude Code, Codex CLI
and OpenCode. Two of those are not Crew presets (only `copilot-cli`,
`claude-code` and `shell` exist), but the *intent* behind the sketch was
reasoning diversity: have a different mind review the work than wrote it.

That intent is already satisfiable without writing a single new integration.
**Copilot CLI is a multi-model front end**, and Crew already drives it:

| Capability | Where it already lives |
|---|---|
| Model catalogue, read from the installed CLI's completion script, validated and cached 5 min | `src/main/copilot-models.ts` |
| `withCopilotModel()` injecting `--model` into the launch args | `src/shared/copilot-models.ts` |
| Per-session model picker, hidden when the catalogue is unavailable | `src/renderer/new-session-model.ts` |
| `--session-id=` both setting and resuming a session id | `src/main/presets.ts` |

At the time of writing the installed CLI reported **30 models across six
vendors** — Claude, GPT, Gemini, Grok, Kimi and MAI families. The list is read
at runtime and is never hardcoded, so new models appear without a Crew change.

Therefore:

- A lane's identity is **`(presetId, model)`**, carried on `Lane.agent`.
  "Builder on `claude-opus-5.5`, reviewer on `gpt-6-astra`" is a lane setting,
  not a new transport.
- **Cross-model review is the default recommendation** once roles exist: a
  reviewer on a different vendor's model is materially more likely to catch
  what the author's model missed. This design document is itself the evidence —
  three reviewers converged on one set of findings and a fourth, from a
  different vendor, found the bug that broke the publication lifecycle.
- The catalogue is **advisory, exactly as it is today**. If the CLI does not
  report models, the picker hides and the lane launches on the CLI default.
  A conductor run must never fail because a model list could not be parsed.
- `model` is meaningless for `claude-code` and `shell` and is held `null` for
  them. It is not a general "pick any model" abstraction; it is the Copilot CLI
  flag, and pretending otherwise would invent a capability that does not exist.

**This also shrinks Phase 1b.** The transport spike's risk was needing a
completion signal per preset. If `copilot-cli` alone reaches thirty models,
then solving *one* transport delivers the entire diversity story, and
`claude-code` becomes an enhancement rather than a prerequisite.

## Exclusivity

A lane session belongs to **at most one conducted** workspace.

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
- At most one active lane per role.
- The store validator must **fail closed** on a malformed `Run`. It currently
  accepts unknown workspace fields, so a corrupt run would otherwise load and be
  conducted.

## UI

- **Workspace editor:** a `Conducted` toggle; the repository and integration
  branch; role list; per-edge gate; the test recipe (setup, command, args, cwd,
  timeout) as explicit user-confirmed fields. Rejected toggles show the conflict
  inline.
- **Roster:** per lane — status, `ahead`, `behind`, and a warning (never a
  block) when the lane has uncommitted or untracked files. `behind` is derived
  from `rev-list` only, never incremented by bulletins, which would give the UI
  and the router two disagreeing sources.
- **Lane actions:** **Publish this lane** and **Sync this lane**. In Phase 1
  these are the only triggers; nothing fires automatically.
- **Conductor panel:** the decision log, plus **Pause**, **Step**, **Stop**, and
  — when `needs-recovery` — the reconciliation report with explicit
  continue/abort choices per interrupted operation.

Step permits exactly one decision; follow-up events queue until the next Step.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| target session exited | `stop` with a reason; notify |
| target session asleep | queue; deliver only once readiness is `ready` |
| target session busy | park the work item; drained by `readiness-changed` |
| detector reports `WAITING_APPROVAL` | never write; an injected newline would approve it |
| human types into a conducted session | human takes the input lock; automation pauses for that session |
| briefing run fails | templated report; verified facts still travel |
| test recipe missing but required | lane `block`ed naming the missing recipe |
| lane has uncommitted files | **warn only** — publication uses a frozen commit, so it cannot be contaminated |
| merge conflict | abort merge, release lock, lane `blocked`, paths returned to the agent |
| lane is behind and wants teammates' work | explicit **Sync lane**; Crew never merges into a lane unasked |
| tests fail | same as a conflict |
| `update-ref` CAS fails | external mutation — stop and surface; never blind retry |
| `integrationBranch` is checked out somewhere | refuse to publish; the worktree check runs immediately before the CAS |
| publication times out | kill process group, **confirm exit**, then release lock; journal `interrupted` |
| Crew quits mid-publication | run enters `needs-recovery`; reconcile journal vs refs before any Step |
| two lanes ready at once | one publishes, the other joins `ready`; dequeued by `lock-released` |
| publication fails | `lock-released` is still emitted — the waiter must never starve on a failure path |
| lane teardown refused (dirty) | lane retained and shown; lock never leaked |
| a lane finishes while others work | that lane is `done`; the run continues |
| pipeline edited mid-run | rejected; the run holds a snapshot |
| integration branch drifts from `main` | manual **Refresh base** (merge `main` in, under the lock). Nothing does this automatically |

## Testing

Seams, all injectable: **clock, AgentTransport, LaneManager/facts provider,
TestRunner, RunStore, process supervisor, BriefingService.**

- **Unit (`conductor-route.ts`):** the decision table exhaustively — both-ready,
  FIFO not bypassed by the publisher's own next candidate, `ahead == 0`,
  stale-event, missing-recipe, limit-exceeded, one-lane-done, parked item
  drained by `readiness-changed`.
- **Unit (`conductor-membership.ts`):** exclusivity, multi-window, every
  mutation path.
- **Lane manager, against a real temporary git repo:** create / merge-publish /
  sync / destroy; a deliberate conflict; CAS rejection when the ref moved;
  refusal when the branch is checked out; **a lane publishing twice in a row**
  (the regression that rebase-publishing caused: `ahead` must return to 0 and
  the second publication must not replay the first's commits); refusal to
  destroy dirty; non-interactive env. Real git is required — merge metadata and
  ref semantics cannot be faked credibly.
- **Runtime, adversarial:** concurrent CAS attempts; publication failure wakes
  the waiter; crash immediately before and after `update-ref`; restart with
  `MERGE_HEAD` present; killed during tests leaving a dirty integration
  worktree; store write failure before an effect; duplicate and late events
  after pause/stop/removal; retry exhaustion with zero handoffs; delivery into a
  busy session; the five detector traces above.
- **E2E:** two fake-CLI lanes touching one file. Assert concurrent work,
  serialized publication, the second lane's work merged onto the first, the
  bulletin naming the first's commit, both commits on the integration branch,
  the user's own checkout untouched, and a clean recovery from a simulated
  mid-publication
  kill.

## Non-goals (v1)

- The conductor opening PRs or merging to `main`.
- Preventing agents from running git themselves. Crew serializes **its own**
  publications and detects external mutation; it is not a sandbox.
- Semantic conflict detection beyond the test command.
- Agent-to-agent messaging without Crew in the middle.
- Cross-workspace or cross-repository conducting.
- Conflict *resolution* by the conductor.

## Review gates publication

**Decided: review happens before publication.** A reviewer's verdict blocks the
merge; it is not a follow-up commit filed after the code has already landed.

This was the round-two open question, and it is the answer that matches what
people mean by "reviewer" — a `needs-changes` verdict that cannot stop anything
is not a review, it is a comment. But it changes four things, and the
non-obvious one is the third.

**1. Reviewers own no branch.** `Role.kind` distinguishes `author` from
`reviewer`. A reviewer lane's `branch` is `null` and its worktree is **detached
at the candidate SHA** — the same discipline as the integration worktree, for
the same reason. It must not read the author's lane worktree, which keeps moving
underneath it; a reviewer that reports on code that has since changed is worse
than no reviewer. `has-commits` is never evaluated for a reviewer lane, since it
has no commits of its own and would block on a gate it can never satisfy.

**2. The candidate is frozen, and the verdict is keyed to the SHA.** The handoff
fires on `candidate-frozen`, carrying the author's exact lane tip. `Review` is
keyed by `candidateSha`, not by lane. If the author commits again while review
is in flight, the verdict no longer matches `laneTip` and is **discarded, not
applied** — which the runtime already does for free, because "event whose
`laneTip` no longer matches → stale, dropped" is an existing rule. Without this,
an agent could get an approval and then push more code under it.

**3. Review must not hold the publication lock.** This is the part that is easy
to get wrong. A review is an LLM turn — seconds to minutes. The publication lock
is single-flight across the whole run. Holding the lock across a review would
serialise every lane in the workspace behind one reviewer's thinking time, which
destroys the only reason the feature has parallel lanes at all.

So the sequence is: freeze the candidate → **review runs entirely lock-free** →
on `approved` the lane enters `ready` and contends for the lock normally → the
runtime revalidates `laneTip === candidateSha` under the lock before merging.

The cost of this is honest and must be stated: between a verdict and its merge,
another lane may land work that the reviewer never saw. **Approval is a judgment
about a candidate in isolation, not about the integration result.** The
`tests-pass` gate, which runs inside the lock against the post-merge tree, is
the backstop — and per the guarantees table, semantic conflicts remain
unprevented. Serialising review to close this window would cost far more than
the window is worth.

**4. `needs-changes` must be a loop with a bound, not a wall.** The verdict
returns to the author as a work item and the lane goes back to `working`. Every
such round trip is a dispatch and **counts against `maxDispatches`** — this is
precisely the case the "count every dispatch, not just handoffs" rule exists
for, since an author and reviewer can ping-pong indefinitely while traversing no
new edge.

**Liveness.** A reviewer that dies, hangs or never answers would otherwise block
its author forever. `Review.deadlineAt` bounds it: on expiry the lane goes
`blocked` with the reason named, never a silent hold. The user can always
override and publish without a verdict; the override is **written to the
journal**, because an unrecorded bypass of a gate makes the journal a liar about
what was reviewed.

**None of this lands in Phase 1.** Phase 1 has a manual Publish button, so the
human pressing it *is* the review gate. `Role`, `Edge`, `Review` and the gate
set are specified here so Phase 2 has a target, but Phase 1 implements none of
them.

## Phasing

All four reviews independently concluded the original Phase 1 — toggle, roles,
worktrees, router, baton, briefings, bulletins, decision log, pause/step,
exclusivity — was the whole product, built on git machinery that does not exist
and a turn boundary that is not trustworthy. Re-phased so each layer ships on top
of something already watched working:

**Phase 1 — the publication mutex, manually triggered.** One repo, chosen in the
workspace's conductor settings. Lane worktrees on their own branches; a
permanently detached integration worktree; the user's checkout never a merge
target. At most two lanes. Single-flight lock, merge-based publication with a
ref CAS, Sync lane, the two-write journal and recovery, non-interactive git, and
a process supervisor that reaps before releasing.

The UI shows `ahead`/`behind`/dirty per lane with **Publish this lane** and
**Sync this lane** buttons.

Phase 1's data model is **only** `Lane`, `Run`, the integration branch and the
`TestRecipe`. `Role`, `Edge`, `Review`, `Pipeline` edges and the gate set are
now specified (review gates publication — see above), but Phase 1 **implements
none of them**: with a manual Publish button, the human pressing it is the
review gate. They are written down so Phase 2 has a target, not so Phase 1 has
more to build.

No PTY injection, no LLM briefings, no bulletins that instruct git, no question
relay, no detector-triggered automation. This is the part that can corrupt a
production repo, and it is fully testable against a temp git repo with no agent
in the loop.

**Phase 1b — the transport spike (runs in parallel, time-boxed).** Phase 1
cannot prove or disprove Phase 2's riskiest assumption: *that a trustworthy
completion signal exists per preset*. So a one-to-two-week spike **measures**
signals without building the transport:

- **Shell already has one.** `src/main/crew-hook/index.ts` emits OSC 133
  (FinalTerm) semantic marks including `D;exit`. That is a real, zero-risk
  baseline that the earlier rounds overlooked entirely.
- **Claude Code:** its hooks (a `Stop` hook) are the mechanism for *interactive*
  sessions. Note the earlier draft's reasoning — "richest structured output" —
  described `-p`/stream-json, which is headless and irrelevant to a PTY session.
  Any injected hook config must live **outside** the worktree (via a settings
  flag, to be confirmed), since an untracked file inside it would show the lane
  as dirty.
- **Copilot CLI — now the priority target, not the afterthought.** It is Crew's
  default preset *and* the multi-model front end (see "Which agent runs a
  lane"), so a completion signal here alone delivers the whole cross-model
  story. Its signal is still unknown and must be measured first. If none
  exists, that is the single most important thing the spike can tell us, and it
  is far better learned before a multi-preset transport is designed than after.

**Phase 2 — automation.** The `AgentTransport` contract with a real completion
signal per preset, readiness-gated delivery, the input lock, work-result
handoffs, bulletins, the dispatcher and ready set, autonomy bounds — and the
reviewer role, whose verdict gates publication **without ever holding the
publication lock**.

**Phase 3 — briefings and relay.** The LLM briefing on handoff; then the question
relay with request ids, correlation and expiry.

**Phase 4 — gated auto-merge**, once the coordination has been watched working.

## Resolved review questions

1. **`maxLanes` default: 2**, three opt-in. Two exposes every concurrency and
   integration problem and supports builder/reviewer. Limits on stored worktrees,
   active agents, briefing runs and test processes are separate counters.
2. **Gates:** `diff-nonempty` is replaced by `has-commits` (`ahead > 0`), and
   `tests-pass` is evaluated only inside the publication transaction. A fourth,
   `review-approved`, was added once review was decided to gate publication. A
   reviewer's `needs-changes` outcome blocks a transition even when tests pass —
   approval is never inferred from quiescence.
3. **Test command:** an explicit, user-confirmed per-workspace `TestRecipe`,
   executed with `execFile` and no shell, **with a setup step** so the
   integration worktree has dependencies. `package.json` scripts may be
   *suggested*, never silently executed: they are arbitrary code, monorepos have
   several, and not every repo is Node. Missing recipe is a visible `block`.
4. **Restart:** never auto-resume — but **reconciliation must precede Step or
   Resume**. Persist counters, phases, ref identities and pending deliveries. A
   stopped app is not evidence its last operation failed.
5. **Question relay:** Phase 3, and kept out of the v1 event model entirely.

## Decisions made by the user

**Ordering: Phase 1 first.** Phase 1 as re-scoped has no agent automation in it
— it is the git safety layer with a manual button. All four reviewers
recommended shipping it first, and the round-two reviewer recommended running
the **Phase 1b transport spike alongside it** rather than after, so that Phase
2's riskiest assumption is measured while Phase 1 is being built. That is the
plan of record above, and it is the approved plan.

The alternative — building the shell-preset transport first, since it already
emits OSC 133 `D;exit` marks, to demo coordination sooner — was considered and
**not** taken. Sequencing risk beat seeing agents coordinate sooner.

**Review gates publication**, as specified above. Decided 28 Sep 2026.

**Cross-model review is the default recommendation** once roles exist: a
reviewer on a different vendor's model than the author. See "Which agent runs a
lane".
