# Conducted workspaces — a conductor that hands work between sessions

**Status:** Design proposal — awaiting review
**Date:** 2026-09-28
**Author:** brainstorming session

## Summary

Add a **conducted** toggle to a workspace. In a conducted workspace the member
sessions stop being independent coworkers and become a **coordinated team**:
they work in parallel on isolated branches, they are kept informed of what the
others have landed, and their check-ins are serialized so two agents can never
commit conflicting work.

Crew sits in the middle of every exchange. It decides *when* work moves and
*who may check in* (deterministic, testable, free); a single headless LLM run
writes *what one agent tells another* (the one job rules are bad at).

The feature's purpose is coordination: **no conflicting check-ins, and every
agent working from an accurate picture of what its teammates have done.**


## Why hybrid

Three models were considered.

**A — conductor as a brain.** Its own CLI process reads session state and decides
who goes next in natural language. Handles unanticipated work, but makes *control
flow* nondeterministic — the one layer where that is intolerable. Three
autonomous CLIs with write access plus a free-associating conductor and nobody
watching is a credit burn with commits in it. It is also close to undebuggable:
you cannot ask "which rule fired?", only "what was it thinking?" Worse, deciding
by reading transcripts means every decision re-reads a growing pile of output, so
cost grows superlinearly with session count — backwards for a workspace feature.

**B — pure rules.** Predictable and free, and sufficient for routing. It fails at
the *payload*: when a builder finishes, the reviewer needs to know what changed
and why, not `exit 0`. Templated summaries are accurate and useless.

**C — hybrid (CHOSEN).** Deterministic routing, LLM-written briefings. Each
failure mode lands where it is cheap: a bad routing decision is impossible
(routing is unit-tested code), and a bad briefing is survivable (the receiving
agent asks a question; you see it in the transcript). Cost is one small run per
edge traversed, not continuous supervision.

## Lanes and the integration baton

The design rests on one split:

> **Work happens in parallel. Integration happens one at a time.**

**A lane** is a unit of parallel work: one role, one git **worktree**, one
branch. Because each lane is a separate directory, two agents editing at once is
structurally impossible — not a race that messaging has to win. This is why
worktree management is **in v1**: it is not an optimisation, it is the mechanism
that makes concurrency safe.

**The integration baton** is a single token. A lane may only `git` check in —
rebase, commit, push, merge to the integration branch — while holding it.
Exactly one lane holds it at a time, so **check-ins are serialized even though
work is parallel**. This is precisely how a functioning human team avoids
stepping on each other, and it is the smallest mechanism that makes conflicting
check-ins impossible rather than merely unlikely.

What this buys:

- Two agents cannot edit the same file simultaneously (separate worktrees).
- Two agents cannot commit simultaneously (one baton).
- A lane that integrates second always rebases onto the first one's work, so it
  *sees* the conflict during its own turn, while it has the context to fix it —
  rather than a human discovering it later in a merge.
- "What is this workspace doing?" always has an answer: N lanes working, ≤1
  integrating.

The baton is a scheduling token, not a queue position: the router decides who
gets it next from the same pure decision table as everything else.


## How agents talk to each other

Agents do not message each other directly — the CLIs have no protocol for it,
and a hand-rolled one would depend on each agent reliably emitting structured
markers, which they do not. **Every exchange is conductor-mediated**, which is
also what makes it observable and testable. Crew is always in the middle.

There are three kinds of message, and only the first is a handoff.

### 1. Briefing (directed, on handoff)

When work moves from role A to role B, one headless LLM run summarises what A
did and what B must do, and Crew types it into B's session. Details below.

### 2. Bulletin (broadcast, on integration)

The coordination mechanism. When a lane lands work on the integration branch,
every *other* active lane is told — deterministically, no LLM:

> **Lane `reviewer` landed `a1b2c3d`:** "Fix pagination off-by-one".
> Touched `src/list.ts`, `test/list.test.ts`.
> Your branch is now 1 commit behind. Rebase before you check in.

This is what keeps agents from working on stale assumptions. An agent that
learns mid-task that a teammate just rewrote the file it is editing can adapt
*during* its turn, instead of discovering it at integration.

Bulletins are delivered via `SessionManager.input()` like any other text, and
are **coalesced**: a lane that is mid-turn receives one merged bulletin at the
end of its turn rather than an interruption per commit. Interrupting a working
agent with a wall of notifications is how you get worse output, not better
coordination.

### 3. Question relay (directed, on request)

An agent that needs something from a teammate — "did you intend `parse()` to
return null?" — emits a marker line. The conductor routes the question to the
owning lane, waits for that lane's next turn to complete, and relays the answer
back.

The marker is a fenced, unambiguous token (`@crew ask <role>: <question>`)
scanned for in the agent's own output. **A missed marker degrades to nothing** —
the agent simply proceeds on its own assumption, exactly as it would today. The
relay is therefore an enhancement that cannot deadlock the pipeline, never a
dependency of it. Unanswerable or unrouteable questions are logged and dropped,
not retried.

### What is deliberately absent

No shared scratchpad file, no agents writing to each other's directories, no
agent invoking another agent. Each is a way for two autonomous processes to
corrupt shared state without Crew being able to see it happen.

## Existing machinery this builds on

Most of the primitives already exist, which is why the new surface is small.

| Need | Already in Crew |
|---|---|
| "a session finished its turn" | `detection.ts` — prompt/approval regex + quiescence, already emits `WAITING` |
| deliver work to a session | `SessionManager.input(id, data)` — writes to the PTY and wakes a sleeping session |
| run a one-shot LLM | `agent-runner.ts` — spawns `copilot -p` / `claude -p`, streams, times out, caps output |
| workspace membership | `shared/workspaces.ts` — first-class `Workspace` ids, `sessionInWorkspaceId` |
| autonomy state | `autopilot.ts` — knows when an agent is running unattended |

The genuinely new machinery is **git worktree management**, which Crew does not
have at all today (`github.ts` only resolves remote URLs). Lane creation,
rebasing, and teardown are the largest single piece of work in this spec —
larger than the router.

New code is the router, the conductor runtime, the git lane manager, and the
store fields.

## Data model

```ts
// shared/types.ts
export interface Workspace {
  id: string
  name: string
  description?: string
  order: number
  createdAt: number
  /** Conducted workspaces route work between their sessions. */
  conducted?: boolean
  /** Role assignments and edges. Present only when conducted. */
  pipeline?: Pipeline
}

export type RoleId = string
export type LaneId = string

export interface Role {
  id: RoleId
  name: string              // "Builder", "Reviewer"
  sessionId: string | null  // which session fills this role
  order: number
}

/** One unit of parallel work: a role, a worktree, a branch. */
export interface Lane {
  id: LaneId
  role: RoleId
  /** Absolute path to this lane's git worktree. */
  worktree: string
  branch: string
  /** Commits on the integration branch this lane has not yet rebased onto. */
  behind: number
  status: 'working' | 'ready' | 'integrating' | 'blocked' | 'done'
}

export interface Edge {
  from: RoleId
  to: RoleId | 'done'
  gate: GateId
}

export type GateId = 'always' | 'diff-nonempty' | 'tests-pass'

export interface Pipeline {
  roles: Role[]
  edges: Edge[]
  lanes: Lane[]
  /** The single integration baton: the lane permitted to check in, or null. */
  integrating: LaneId | null
  /** Branch every lane rebases onto and merges into. */
  integrationBranch: string
  limits: Limits
}

export interface Limits {
  maxHandoffs: number       // total, per run
  maxEdgeTraversals: number // per edge — kills builder/reviewer ping-pong
  maxLanes: number          // concurrent worktrees; bounds disk and CPU
}
```

Roles, not sessions, are the unit of routing. Swapping Claude Code for Codex CLI
in a slot changes the `sessionId` on a role and nothing about the routing.

## The router

The entire routing engine is one pure function.

```ts
// shared/conductor-route.ts
export function route(state: ConductorState, event: ConductorEvent): Decision

export type Decision =
  | { kind: 'handoff'; from: RoleId; to: RoleId; reason: string }
  | { kind: 'grant-integration'; lane: LaneId; reason: string }
  | { kind: 'require-rebase'; lane: LaneId; behind: number; reason: string }
  | { kind: 'hold'; reason: string }
  | { kind: 'stop'; reason: string }
```

`grant-integration` is the baton moving. `require-rebase` is the conductor
telling a lane it is stale before it may check in — the mechanism that makes
conflicting check-ins impossible.

**No IO inside `route()`.** It never shells out, never reads a clock, never
randomises. Crew gathers facts *first* and passes them on the event as a plain
snapshot:

```ts
export interface Facts {
  diffLines: number            // git diff --numstat, summed
  testsExitCode: number | null // null = not run
  /** Commits on the integration branch this lane has not rebased onto. */
  behind: number
}

export interface ConductorEvent {
  kind: 'turn-complete' | 'integration-complete'
  role: RoleId
  lane: LaneId
  facts: Facts
}

/** Everything routing may consider. Pure data — no handles, no callbacks. */
export interface ConductorState {
  pipeline: Pipeline
  /** Live sessions, so routing can stop rather than hand off to a dead one. */
  sessionStatus: Record<RoleId, 'running' | 'asleep' | 'exited' | 'unassigned'>
  handoffs: number
  /** Traversals so far, keyed `${from}->${to}`. */
  edgeTraversals: Record<string, number>
}
```

This is what makes the engine testable with fake sessions and zero LLM calls —
which matters, because this codebase's safety net is 839 fast tests and an
LLM-in-the-loop router would not be coverable by them.

**One trigger family in v1:** `turn-complete` (from `detection.ts`, which already
produces it) and `integration-complete` (from the conductor's own git step). No
timers, no polling.

**Gates are pure predicates over `Facts`:**

| Gate | Passes when |
|---|---|
| `always` | unconditionally |
| `diff-nonempty` | `diffLines > 0` — the builder actually changed something |
| `tests-pass` | `testsExitCode === 0` |

Three is enough. More is YAGNI until a real case demands one.

**Stop conditions live inside routing, not bolted on.** `maxHandoffs` and
`maxEdgeTraversals` are part of `ConductorState`, and `stop` is a first-class
decision, so "the conductor gave up, and why" is always answerable from the
decision log.

### Decision table

| Situation | Decision |
|---|---|
| lane finished, gate passes, baton free, lane up to date | `grant-integration` |
| lane finished, gate passes, baton free, lane is behind | `require-rebase` |
| lane finished, gate passes, **baton held by another lane** | `hold` (wait your turn — this is the serialization) |
| gate fails | `hold`, with the failing gate named |
| integration completed, an onward edge exists | `handoff` to the next role |
| integration completed, edge target is `done` | `stop` (`'pipeline complete'`) |
| next role has no session assigned | `stop` |
| `maxHandoffs` or `maxEdgeTraversals` exceeded | `stop` |
| event from a lane the state does not know | `hold` (stale event) |
| target role's session has exited | `stop` |

Note that the baton being held is a `hold`, never a queue or a wait primitive.
Routing stays a pure function of current state; the waiting lane is simply
re-evaluated when the next event arrives. There is no scheduler to deadlock.

## The conductor runtime

`src/main/conductor.ts` — owns the loop, does all the IO the router refuses to.

On `turn-complete` for a conducted session:

1. **Gather facts** — `git diff --numstat` and `rev-list --count` for `behind`,
   in the lane's worktree; the test command if the edge's gate needs it. Bounded
   and cached, in the style of `github.ts`'s per-cwd TTL, so a busy workspace
   does not spawn a `git` per event.
2. **Call `route()`** — pure, instant.
3. **Act on the decision** (below).
4. **Log it** — every decision is appended to a bounded **decision log** (lane,
   role, gate, outcome, reason, timestamp) that the UI renders. This is the
   debugging surface: you can always read back exactly why the baton moved.

### Acting on each decision

| Decision | Action |
|---|---|
| `require-rebase` | type a rebase instruction into the lane's session; it stays `working` |
| `grant-integration` | take the baton, run the integration procedure |
| `handoff` | briefing run → `SessionManager.input(target, briefing)` |
| `hold` | update UI state only; no session is touched |
| `stop` | release the baton, notify, mark the pipeline finished |

### The integration procedure

Runs only while the lane holds the baton, in the lane's worktree:

1. `git fetch` the integration branch.
2. **Rebase.** On conflict: hand the conflict *back to the lane's own agent* as
   a message, release the baton, and mark the lane `blocked`. The agent that
   wrote the code resolves the conflict, with full context, during its own turn.
   The baton is never held across a conflict — that would stall every other
   lane behind a stuck one.
3. Run the workspace's test command. On failure: same treatment as a conflict —
   back to the lane, release the baton.
4. Merge into the integration branch (fast-forward).
5. **Broadcast a bulletin** to every other active lane, incrementing their
   `behind` counts.
6. Release the baton and emit `integration-complete`, which re-enters `route()`
   and lets the next waiting lane in.

**The baton is released on every exit path, including failure.** A conductor
that can lose the baton is a conductor that deadlocks, so release is structured
as a `finally`, and a lane's claim on it is additionally bounded by a timeout.

### The briefing (the only LLM call)

One headless run through the existing `agent-runner`, read-only, in the outgoing
session's cwd:

> You are handing work to a teammate. Summarise what was just done in this
> repository and what the next person must do. Be specific and short.

Context supplied: the outgoing role's name, the incoming role's name, the task,
the diff stat, and a tail of the outgoing session's transcript.

**If the briefing run fails or times out, fall back to a templated summary**
(role names, task, diff stat). A degraded handoff, never a stalled pipeline —
the pipeline's liveness must not depend on an LLM call succeeding. Bulletins and
rebase instructions are templated and never involve an LLM at all, so the
coordination that prevents conflicts has no LLM in its path.

## The lane manager

`src/main/lanes.ts` — the new git machinery, isolated behind a narrow interface
so the conductor never shells out to git itself.

```ts
export interface LaneManager {
  create(repo: string, branch: string): Promise<Lane>   // git worktree add
  behind(lane: Lane, base: string): Promise<number>     // rev-list --count
  rebase(lane: Lane, base: string): Promise<RebaseResult>
  merge(lane: Lane, base: string): Promise<MergeResult>
  destroy(lane: Lane): Promise<void>                    // git worktree remove
}

/** Conflicts are data, not exceptions: the conductor must report the paths to
 *  the agent that wrote them, so they are part of the normal return type. */
export type RebaseResult =
  | { ok: true; rebased: number }
  | { ok: false; conflictPaths: string[]; message: string }

export type MergeResult =
  | { ok: true; commit: string; touchedPaths: string[] }
  | { ok: false; message: string }
```

Rules learned from this repository's own worktree setup, which the manager must
respect:

- Worktrees live under `.worktrees/` and that directory is git-ignored.
- **`node_modules` inside a worktree is a symlink to the root's.** Anything that
  replaces it with a real directory breaks the worktree and pollutes the commit.
  The manager creates the symlink on `create` and verifies it before handing the
  lane to an agent.
- `destroy` refuses to remove a worktree with uncommitted changes unless
  explicitly forced, so a crash never silently discards an agent's work.

## Exclusivity

A session may belong to many workspaces but **at most one conducted** workspace.
Without this, two pipelines could hand the same session conflicting work.

The "only one workspace is open at a time" intuition does **not** hold and cannot
be relied on:

- `activeWorkspace` is a *per-window* view preference (`readViewPref`, namespaced
  by window slot in `window-scope.ts`), so two windows can have two workspaces
  active simultaneously.
- Conducting must keep running when you switch away — otherwise it is a
  foreground mode, not orchestration.

So **"active" (view) and "conducting" (runtime) are decoupled**, and exclusivity
is enforced on membership data:

```ts
// shared/conductor-membership.ts — pure
export interface Conflict {
  sessionId: string
  sessionLabel: string
  /** The conducted workspace already claiming this session. */
  heldBy: { id: string; name: string }
}

export function canConduct(
  workspaces: readonly Workspace[],
  sessions: readonly SessionInfo[],
  wsId: string
): { ok: true } | { ok: false; conflicts: Conflict[] }
```

- Toggling a workspace to conducted **fails loudly** if any member session is
  already conducted elsewhere, naming the session and the other workspace.
- Adding an already-conducted session to a conducted workspace is rejected the
  same way.
- Both are pure functions over store data, cheap to unit-test, enforced in the
  main process so no UI path can bypass them.

## UI

- **Workspace editor:** a `Conducted` toggle. When on, a compact role list
  (drag to order, each row picks a member session), the gate per edge, the
  integration branch, and the test command. Rejected toggles show the naming
  conflict inline.
- **Roster:** a conducted workspace is marked in the header. Each lane shows its
  status (`working` / `ready` / `integrating` / `blocked`) and how many commits
  it is behind, so "who is working, who is waiting to check in, and who is
  stale" is readable at a glance.
- **Conductor panel:** the decision log — a plain list of
  `lane → decision (gate, reason)` entries — plus Pause and Step. Pause stops
  routing without touching the sessions; Step permits exactly one decision.

Pause is the safety valve: the answer to "it is doing something I do not like"
must never be "quit Crew".

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| target session exited | `stop` with a reason; notify |
| target session asleep | `SessionManager.input` already wakes it |
| briefing run fails | templated fallback briefing |
| gate's test command missing | gate evaluates false → `hold`, with a reason naming the missing command |
| role has no session | `stop`, not a crash |
| ping-pong between two roles | `maxEdgeTraversals` → `stop` |
| **rebase conflict** | conflict handed back to the lane's own agent; baton released; lane `blocked` |
| **tests fail at integration** | same as a conflict — back to the lane, baton released |
| **integration crashes or times out** | baton released in a `finally`; lane `blocked`; never a permanent stall |
| **two lanes ready at once** | one gets `grant-integration`, the other `hold`; re-evaluated on `integration-complete` |
| **a lane is behind** | `require-rebase` before the baton is ever granted |
| worktree creation fails (dirty repo, bad branch) | lane not created; `stop` with the git error surfaced |
| `node_modules` symlink missing in a worktree | lane refuses to start; repaired and retried once |
| session removed from workspace mid-flight | its lane is torn down (refusing to discard uncommitted work); others continue |
| Crew quits mid-pipeline | pipeline state persists; worktrees are left intact; the baton is **not** auto-resumed on launch — resuming requires an explicit Step or Resume, so a restart never silently restarts autonomous work |
| a human types into a conducted session | treated as a turn like any other; the human is simply another participant |

## Testing

- **Unit (`shared/conductor-route.ts`):** the decision table above, exhaustively,
  including both-lanes-ready, behind-lane, and baton-held cases. Pure input →
  output, no mocks, no LLM, no clock.
- **Unit (`shared/conductor-membership.ts`):** exclusivity accept/reject cases,
  including the multi-window scenario that motivates it.
- **Lane manager (`src/main/lanes.ts`):** against a real temporary git
  repository — create/rebase/merge/destroy, a deliberately conflicting rebase,
  the `node_modules` symlink invariant, and the refusal to destroy a dirty
  worktree. Git is fast enough that these stay unit-test speed.
- **Runner (`src/main/conductor.ts`):** a fake `SessionManager` and a fake base
  command (a node script emitting a canned briefing) drive
  turn-complete → facts → decision → input, plus the briefing-failure fallback
  and **baton release on every failure path**.
- **E2E:** a conducted workspace of two fake-CLI sessions working in two lanes
  that touch the same file. Assert both work concurrently, their check-ins are
  serialized, the second receives a rebase instruction and a bulletin naming the
  first's commit, the integration branch ends with both commits, and 0 renderer
  errors.

## Non-goals (v1 — YAGNI)

- The conductor opening PRs or merging to `main`. The pipeline integrates onto
  its own branch; the human ships it. Autonomous merge is a trust step to take
  separately, after the coordination has been watched working.
- Agent-to-agent messaging without Crew in the middle.
- Cross-workspace conducting.
- Cross-repository lanes.
- Conflict *resolution* by the conductor — conflicts always go back to the agent
  that wrote the code.

## Phasing

- **Phase 1 (this spec):** conducted toggle, roles, lanes with git worktrees,
  pure router, the integration baton, briefings and bulletins, decision log,
  pause/step, exclusivity.
- **Phase 2:** the question relay, richer gates, and lane auto-scaling (spawn a
  lane per queued task rather than per declared role).
- **Phase 3:** gated auto-merge — the pipeline opens the PR once it is trusted.

## Open questions for review

1. **Lane count:** what is a sensible `maxLanes` default? Each lane is a full
   worktree (disk) plus a running agent (CPU, tokens). Three?
2. **Gates:** are `always` / `diff-nonempty` / `tests-pass` enough to start?
3. **Test command:** where does it come from — a per-workspace field, or detected
   from `package.json`?
4. **Restart:** is "never auto-resume a pipeline on launch" the right default?
5. **Question relay:** worth having in v1, or is Phase 2 right? It is the most
   speculative piece, since it depends on agents emitting a marker reliably.
