# Conducted workspaces — a conductor that hands work between sessions

**Status:** Design proposal — awaiting review
**Date:** 2026-09-28
**Author:** brainstorming session

## Summary

Add a **conducted** toggle to a workspace. In a conducted workspace the member
sessions stop being independent coworkers and become a **pipeline**: when one
finishes its turn, Crew decides who works next, writes that agent a briefing
describing what just happened, and types it into their session.

The conductor is a **hybrid**: Crew decides *when* and *whether* work moves
(deterministic, testable, free); a single headless LLM run decides *what to say*
when it moves (the one job rules are bad at).

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

## The baton

**Exactly one session in a conducted workspace holds the baton.** Routing is
only ever the question *who gets the baton next*.

This is the simplifying constraint the whole design rests on:

- Two agents can never edit concurrently, so **git worktree isolation is not a
  v1 prerequisite**. One writer at a time can share a working directory safely.
  (Crew has no worktree machinery today; `github.ts` only resolves remotes. This
  constraint removes what would otherwise be the single largest piece of work.)
- There is always exactly one answer to "what is this workspace doing?"
- Deadlock and interleaving bugs are structurally impossible rather than tested
  against.

**The cost, stated plainly:** v1 is serial. Two independent features run one
after the other, not at once.

Parallelism is the natural Phase 2: N batons ("lanes"), one git worktree each,
converging at a join stage. The v1 data model is deliberately shaped so a lane id
can be added without reshaping routing.

## Existing machinery this builds on

Most of the primitives already exist, which is why the new surface is small.

| Need | Already in Crew |
|---|---|
| "a session finished its turn" | `detection.ts` — prompt/approval regex + quiescence, already emits `WAITING` |
| deliver work to a session | `SessionManager.input(id, data)` — writes to the PTY and wakes a sleeping session |
| run a one-shot LLM | `agent-runner.ts` — spawns `copilot -p` / `claude -p`, streams, times out, caps output |
| workspace membership | `shared/workspaces.ts` — first-class `Workspace` ids, `sessionInWorkspaceId` |
| autonomy state | `autopilot.ts` — knows when an agent is running unattended |

New code is the router, the conductor runtime, and the store fields.

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

export interface Role {
  id: RoleId
  name: string              // "Builder", "Reviewer"
  sessionId: string | null  // which session fills this role
  order: number
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
  /** Who currently holds the baton. null = idle, nothing in flight. */
  baton: RoleId | null
  limits: Limits
}

export interface Limits {
  maxHandoffs: number       // total, per run
  maxEdgeTraversals: number // per edge — kills builder/reviewer ping-pong
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
  | { kind: 'hold'; reason: string }
  | { kind: 'stop'; reason: string }
```

**No IO inside `route()`.** It never shells out, never reads a clock, never
randomises. Crew gathers facts *first* and passes them on the event as a plain
snapshot:

```ts
export interface Facts {
  diffLines: number            // git diff --numstat, summed
  testsExitCode: number | null // null = not run
}

export interface ConductorEvent {
  kind: 'turn-complete'
  role: RoleId
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

**One trigger in v1:** `turn-complete`. `detection.ts` already produces it. No
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
| gate passes, next role has a session | `handoff` |
| gate fails | `hold` (the human sees the workspace idle with a reason) |
| next role has no session assigned | `stop` |
| `maxHandoffs` or `maxEdgeTraversals` exceeded | `stop` |
| event from a role that does not hold the baton | `hold` (stale event) |
| target role's session has exited | `stop` |

## The conductor runtime

`src/main/conductor.ts` — owns the loop, does all the IO the router refuses to.

On `turn-complete` for a conducted session:

1. **Gather facts** — `git diff --numstat` in the session cwd; the test command
   if the edge's gate needs it. Bounded and cached, in the style of
   `github.ts`'s per-cwd TTL, so a busy workspace does not spawn a `git` per
   event.
2. **Call `route()`** — pure, instant.
3. **On `handoff`:** ask the LLM for a briefing (below), then
   `SessionManager.input(targetSessionId, briefing + '\r')`. Move the baton.
4. **On `hold` / `stop`:** update state, surface it in the UI, and — for `stop` —
   notify, since the pipeline has finished or given up while the human was away.

Every decision is appended to a bounded in-memory **decision log** (role, gate,
outcome, reason, timestamp) that the UI renders. This is the debugging surface:
you can always read back exactly why the baton moved.

### The briefing (the only LLM call)

One headless run through the existing `agent-runner`, read-only, in the outgoing
session's cwd:

> You are handing work to a teammate. Summarise what was just done in this
> repository and what the next person must do. Be specific and short.

Context supplied: the outgoing role's name, the incoming role's name, the task,
the diff stat, and a tail of the outgoing session's transcript.

**If the briefing run fails or times out, fall back to a templated summary**
(role names, task, diff stat). A degraded handoff, never a stalled pipeline —
the pipeline's liveness must not depend on an LLM call succeeding.

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
  (drag to order, each row picks a member session) and the gate per edge.
  Rejected toggles show the naming conflict inline.
- **Roster:** a conducted workspace is marked in the header; the baton-holding
  session gets a distinct indicator so "who is working" is readable at a glance.
- **Conductor panel:** the decision log — a plain list of `role → role (gate,
  reason)` entries, plus Pause and Step. Pause stops routing without touching
  the sessions; Step permits exactly one handoff.

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
| session removed from workspace mid-flight | baton cleared; `stop` |
| Crew quits mid-pipeline | pipeline state persists; baton is **not** auto-resumed on launch — resuming requires an explicit Step or Resume, so a restart never silently restarts autonomous work |
| a human types into a conducted session | treated as a turn like any other; the human is simply another participant |

## Testing

- **Unit (`shared/conductor-route.ts`):** the decision table above, exhaustively.
  Pure input → output, no mocks, no LLM, no clock.
- **Unit (`shared/conductor-membership.ts`):** exclusivity accept/reject cases,
  including the multi-window scenario that motivates it.
- **Runner (`src/main/conductor.ts`):** a fake `SessionManager` and a fake base
  command (a node script emitting a canned briefing) drive
  turn-complete → facts → decision → input, plus the briefing-failure fallback.
- **E2E:** a conducted workspace of two fake-CLI sessions completes a
  builder → reviewer → done pipeline; assert the baton moves, the reviewer
  receives text, the decision log has three entries, and 0 renderer errors.

## Non-goals (v1 — YAGNI)

- Parallel lanes and git worktree isolation (Phase 2).
- The conductor opening PRs or merging. The pipeline ends at `done`; the human
  merges. Autonomous merge is a trust step to take separately, after the routing
  has been watched working.
- Agent-to-agent messaging without Crew in the middle.
- Cross-workspace conducting.
- More than one trigger kind.

## Phasing

- **Phase 1 (this spec):** conducted toggle, roles, linear pipeline, pure router,
  briefing, decision log, pause/step, exclusivity.
- **Phase 2:** lanes — N batons with a git worktree each, joining at a stage.
  This is where the diagram's parallel Feature A ∥ Feature B arrives.
- **Phase 3:** gated auto-merge — the pipeline runs tests and opens the PR.

## Open questions for review

1. **The baton:** is serial-for-now acceptable for v1, with parallel lanes in
   Phase 2? This is the load-bearing assumption; parallel-in-v1 pulls git
   worktree management into scope and roughly doubles the work.
2. **Gates:** are `always` / `diff-nonempty` / `tests-pass` enough to start?
3. **Test command:** where does it come from — a per-workspace field, or detected
   from `package.json`?
4. **Restart:** is "never auto-resume a pipeline on launch" the right default?
