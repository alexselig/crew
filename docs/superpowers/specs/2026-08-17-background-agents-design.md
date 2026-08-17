# Background specialist agents — an on-call "Agents" shelf

**Status:** Design proposal — awaiting review (user asked for thoughts; decisions made autonomously with rationale, to confirm)
**Date:** 2026-08-17
**Author:** brainstorming session

## Summary

Add **specialist agents** to Crew: reusable, user-defined "brains" (UX Critique,
Code Review, Security Review, Doc Writer…) that appear at the **bottom of the
nav** with their own distinct icons — a shelf of *on-call specialists* beneath
the roster of *interactive coworkers*. From any session you invoke a specialist;
Crew runs it **headless/one-shot** against that session's context and returns a
result you can read, insert, or save. Today Crew supervises live interactive PTY
sessions; this extends the model to reusable capabilities-with-a-brain that are
"accessible to various sessions" without you having to babysit a terminal.

This is the natural next step past **skills** (which inject a prompt macro into
your *own* session): a specialist is "a skill with its own brain" that produces a
result.

## Feasibility (validated)

Both base CLIs already support the headless one-shot mode this needs (checked via
`--help`):

- **Copilot:** `-p, --prompt <text>` runs a prompt non-interactively and exits;
  `-C <directory>` sets the working dir; `--allow-all-tools` / `--yolo` grant
  autonomy so a headless run doesn't block on approvals.
- **Claude:** `-p, --print` prints the response and exits; `--output-format
  text|json|stream-json` (stream-json = realtime streaming for a live result
  view); `--max-budget-usd` caps spend; `--no-session-persistence` keeps runs
  from cluttering resumable history.

So Crew can spawn e.g. `copilot -p "<persona>\n\n<task>" -C <cwd> --allow-all-tools`
(or `claude -p … --output-format stream-json`) in the target session's working
dir, stream the output into a result view, and capture the final answer. **The
core mechanism is buildable today.**

## The design fork: how a session "uses" an agent (3 models)

**Model A — On-call specialist (RECOMMENDED).** An agent is a *definition*
(persona + base CLI) that idles at the bottom of the nav. You point it at a
session's context and Crew runs it **headless, one-shot**; the run streams into a
result panel and finishes. "Runs in the background" = the one-shot executes
headlessly while you keep working; the agent row shows a spinner, then a
done-badge. *Pros:* feasible now, matches the skills mental model, no new plumbing
into the CLIs' tool configs, cheap to reason about. *Cons:* not a persistent
conversation; each run is independent (context is re-supplied).

**Model B — Persistent background worker.** Each agent is a long-lived process
you can also open and chat with; sessions send it tasks and stream results over
time. *Pros:* stateful, always-warm. *Cons:* process lifecycle/memory cost,
unclear resume semantics, and the CLIs aren't built to sit idle waiting for
cross-session RPCs — significant new infrastructure for marginal v1 value.

**Model C — Autonomous agent-to-agent.** A running session's CLI agent calls the
specialist itself via an MCP server Crew exposes, no human in the loop. *Pros:*
most powerful, true delegation. *Cons:* requires wiring each CLI's MCP/tool
config back into Crew, trust/loop-guard concerns, and it's the hardest to make
reliable. A compelling *future* layer on top of A, not a v1.

**Recommendation: Model A.** It delivers the requested value ("specialists
accessible to various sessions, running in the background") with today's tools,
and B/C become clean future evolutions (a specialist definition is the same unit
they'd build on).

## Goals (v1)

- A first-class **Agent** definition: name, icon, base CLI, persona prompt.
- An **Agents shelf** at the bottom of the nav, visually distinct from sessions.
- **Invoke a specialist against a session** (from the agent row or a session
  action) with an optional task, running headless in that session's cwd.
- A **result view** that streams the run and, on completion, offers **Copy**,
  **Insert into session**, and **Save to Assets** (a markdown note in the
  session's folder — surfaced by the existing Assets pane).
- A few **built-in specialists** + a **custom-agent editor**.
- Safe by default: headless runs are **read-first**; a write-capable agent is
  clearly flagged.

## Non-goals (v1 — YAGNI)

- Persistent daemons (Model B) and agent-to-agent/MCP delegation (Model C).
- Scheduling/automation, multi-step agent workflows, agents invoking agents.
- Rich visual context (screenshots of the running app for UX critique) — a
  Phase-2 tie-in with the App pane's webview.

## Design (Model A)

### Data model

```ts
// shared/types.ts
export interface Agent {
  id: string
  name: string                 // "UX Critique"
  icon: string                 // a geometric/tool Icon name — NOT an animal mascot
  color?: string               // accent tint for the icon
  base: string                 // preset id providing the CLI + brain: 'copilot-cli' | 'claude-code'
  persona: string              // system/prefix prompt defining the specialist
  /** What to feed the run besides the task: the cwd always; optionally a tail of
   *  the target session's transcript for extra context. */
  contextMode: 'cwd' | 'cwd+transcript'
  /** Read-first (no auto-approve of edits) vs. autonomous (writes allowed). */
  writes: boolean
  order: number
  builtin?: boolean
}

// A single invocation (transient; last run per agent kept in memory).
export interface AgentRun {
  id: string
  agentId: string
  sessionId: string | null     // context source
  cwd: string
  task: string                 // the user's specific ask (may be empty)
  status: 'running' | 'done' | 'error'
  output: string               // streamed stdout
  startedAt: number
  endedAt?: number
  error?: string
}
```

Agent **definitions** persist in the store (`StoreData.agents: Agent[]`, seeded
with built-ins via the existing one-time migration framework). **Runs** are
transient and live in a main-side runner; the renderer sees them over IPC events.

### Run engine — `src/main/agent-runner.ts` (new, isolated)

A small module that owns headless runs, sibling to `session-manager` and
`launcher` (which already spawns child processes):

- `run(agent, { sessionId, cwd, task, transcriptTail? }) → runId`
- Builds argv from the base preset: e.g. Copilot →
  `['-p', persona + '\n\n' + task + context, '-C', cwd, ...(writes ? ['--allow-all-tools'] : [])]`;
  Claude → `['-p', prompt, '--output-format', 'stream-json', ...(writes ? [] : [/* read-first */])]`.
- Spawns via `child_process.spawn` (no PTY needed — `-p` is non-interactive),
  streams stdout → `emit('agent-run-output', { runId, chunk })`, and on exit
  emits `agent-run-done` with status + captured result.
- Enforces a timeout and a max-output cap; kills the process group on cancel.
- Never runs in `$HOME` or a non-session cwd without an explicit target (guards
  the same "don't operate on the whole home dir" class of bug as the App pane).

### IPC + preload + api

- CRUD: `AGENTS_GET`, `AGENT_UPSERT`, `AGENT_DELETE`, `AGENTS_REORDER`.
- Runs: `AGENT_RUN {agentId, sessionId, task}` → runId; `AGENT_RUN_CANCEL {runId}`.
- Events: `EVT_AGENTS` (definitions changed), `EVT_AGENT_RUN` (run state/output
  streamed). Broadcast to all windows, mirroring the roster/workspaces pattern.

### UI

- **Agents shelf** (`AgentShelf.tsx`) pinned at the bottom of the nav, above the
  Total footer: a labeled "Agents" group of `AgentRow`s. Each row: a distinct
  **geometric icon** (e.g. a spark / hexagon / tool glyph, tinted by `color`) to
  read clearly as *not a session*, the agent name, and a status affordance
  (idle → a run spinner → a done dot). A `+`/gear opens the editor.
- **Invoke popover** (`AgentInvoke.tsx`): from an agent row (or a session-header
  "Ask a specialist ▸" menu) — choose the target session (defaults to the
  current one), type an optional task, hit Run.
- **Result drawer** (`AgentRunPanel.tsx`): streams the run's output live; on
  completion shows **Copy**, **Insert into session** (paste the result into the
  target session's composer as context), and **Save to Assets** (write
  `agents/<name>-<ts>.md` into the session cwd so it appears in the Assets pane).
- **Agent editor** (`AgentEditor.tsx`): name, icon/color, base CLI, persona
  (multiline), context mode, and a **"can edit files"** toggle (off by default,
  with a warning when on).

### Components (isolated, single-purpose)

- `src/shared/agents.ts` — pure helpers: default/built-in agents, argv builder
  per base, and validation (unit-tested).
- `src/main/agent-runner.ts` — headless run lifecycle (spawn/stream/cancel).
- `src/main/store.ts` — persist `agents` + built-in seed migration.
- `src/renderer/components/AgentShelf.tsx` / `AgentRow.tsx` /
  `AgentInvoke.tsx` / `AgentRunPanel.tsx` / `AgentEditor.tsx`.

### Built-in specialists (seeded)

- **UX Critique** (read-first): "Review the UX of the app/change in this repo…"
- **Code Review** (read-first): "Review recent changes for correctness/quality…"
- **Security Review** (read-first): "Find high-confidence vulnerabilities…"
- **Doc Writer** (writes, off by default): "Draft/update docs for…"

Each is a persona over a base CLI; users can duplicate/edit or add their own.

## Error handling & edge cases

- **Approval hangs:** a headless run that needs approval would stall — mitigated
  by running `writes:true` agents with the base's auto-approve flag, and
  `writes:false` agents read-first; a run that exceeds the timeout is killed and
  surfaced as `error`.
- **Missing CLI / bad flags:** validated against the base preset; a clear error
  in the result drawer (reuse the New Session install-hint pattern).
- **Cost:** show the run's reported spend; pass `--max-budget-usd` (Claude) where
  available; a per-run cap in settings.
- **No target session:** invoking from the shelf requires picking a session (or
  a folder); never default to `$HOME`.
- **Concurrency & multi-window:** runs live in main and stream to all windows;
  an agent can have at most one active run at a time in v1 (queue or block).

## Testing

- **Unit (`shared/agents.ts`):** argv builder per base (read-first vs writes),
  built-in seed shape, validation. Migration test for the seed.
- **Runner:** a fake base command (a node script echoing a canned result) drives
  `agent-runner` through run → stream → done and cancel/timeout paths.
- **E2E:** create/seed an agent, invoke it against a session using the fake base,
  assert the result streams and "Save to Assets" writes a note that appears in
  the Assets pane; assert 0 renderer errors. A guide screenshot of the shelf.

## Phasing

- **Phase 1 (this spec):** definitions + store + nav shelf + headless runner +
  invoke-against-session + result drawer + save-to-assets + built-ins + editor.
- **Phase 2:** richer context — feed the App pane's screenshot/URL to UX Critique;
  transcript-aware runs; run history per session.
- **Phase 3:** persistent workers (Model B) and/or agent-to-agent via an MCP
  server (Model C), building on the same Agent unit.

## Open questions to confirm on review

1. **Model (primary):** Confirm **A** (on-call headless specialists) for v1, with
   B/C deferred.
2. **Safety posture:** OK to default specialists to **read-first** (no auto-edits)
   and gate write-capable agents behind an explicit toggle + warning?
3. **Result destination:** Is **result drawer + Save-to-Assets** (a markdown note
   in the session folder) the right primary output, with "Insert into session" as
   a secondary action?
4. **Context by default:** `cwd` only, or `cwd + a tail of the session's
   transcript`? (Transcript adds signal but also tokens/cost.)
5. **Scope:** agents are **global** (shown for every session/workspace), correct?
