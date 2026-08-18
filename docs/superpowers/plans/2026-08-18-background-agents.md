# Background Specialist Agents (Phase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Agents" shelf at the bottom of the nav — reusable specialist agents (UX Critique, Code Review, …) you invoke against a session; Crew runs them headless/one-shot in the session's working dir and streams the result into a panel you can copy, insert, or save to the session's assets.

**Architecture:** Agent *definitions* persist in the store (seeded with built-ins). A new isolated `agent-runner.ts` (sibling to `launcher.ts`) spawns the base CLI in headless print mode (`copilot -p` / `claude -p`) via `child_process.spawn`, streams stdout, and captures the result as a transient `AgentRun`. Pure argv/seed logic lives in `shared/agents.ts` (vitest). The renderer adds a nav shelf, an invoke popover, an editor, and a result drawer, wired over IPC that mirrors the roster/workspaces broadcast pattern.

**Tech Stack:** Electron 31 (main/preload/renderer), React 18 + TypeScript, Vitest (unit), Playwright `_electron` (e2e), `node:child_process`.

## Global Constraints

- Node: prefix commands with `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH"`.
- Verify: `npm run typecheck` · `npx vitest run` · `npm run build` · e2e `node test/e2e/crew.e2e.mjs`.
- Push: fetch + `git -c rebase.autoStash=true rebase origin/main` first, then `export TK=$(gh auth token --user alexselig); git -c credential.helper= -c credential.helper='!f(){ echo username=alexselig; echo "password=$TK"; }; f' push origin main`.
- **Model A only** (headless on-call specialists). No persistent workers, no agent-to-agent/MCP (those are later phases).
- **Global agents** — the shelf is the same for every session/workspace (confirmed by user).
- **Read-first by default:** `writes:false` agents run with read-only tool permissions and their persona forbids edits; `writes:true` agents run with the base's full-autonomy flag and are flagged "can edit files" in the UI.
- Headless runs must **never block on approval** (they run unattended) and must have a **timeout** and **max-output cap**; a run never targets `$HOME` without an explicit session/folder.
- Agent id: `ag_${8-char base36}`; run id: `run_${8-char base36}`.
- Commit after each task with the standard trailers: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` and `Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e`.

---

## File Structure

- `src/shared/types.ts` (MODIFY) — `Agent`, `AgentRun` interfaces; new IPC channel consts.
- `src/shared/agents.ts` (CREATE) — pure: `makeAgentId`, `makeRunId`, `BUILTIN_AGENTS`, `buildAgentInvocation`, `validateAgent`, `upsertAgent`, `deleteAgent`, `reorderAgents`.
- `test/agents.test.ts` (CREATE) — unit tests for the pure helpers.
- `src/shared/api.ts` (MODIFY) — `CrewAPI` methods + `onAgents`/`onAgentRun` subscriptions.
- `src/main/store.ts` (MODIFY) — persist `agents: Agent[]`; seed migration `2026-08-agents-seed`; `getAgents`/`saveAgents`.
- `test/store-migrations.test.ts` (MODIFY) — seed migration test.
- `src/main/agent-runner.ts` (CREATE) — headless run lifecycle (spawn/stream/cancel/timeout), `EventEmitter`.
- `test/agent-runner.test.ts` (CREATE) — runner driven by a fake base command.
- `src/main/index.ts` (MODIFY) — IPC handlers; save-result-to-assets; broadcast `EVT_AGENTS`/`EVT_AGENT_RUN`.
- `src/preload/index.ts` (MODIFY) — expose the api methods + subscriptions.
- `src/renderer/hooks.ts` (MODIFY) — `agents`, `runs`, `activeRunId` state + subscriptions.
- `src/renderer/components/AgentShelf.tsx` / `AgentRow.tsx` (CREATE) — nav shelf.
- `src/renderer/components/AgentInvoke.tsx` (CREATE) — invoke popover.
- `src/renderer/components/AgentEditor.tsx` (CREATE) — create/edit modal.
- `src/renderer/components/AgentRunPanel.tsx` (CREATE) — result drawer.
- `src/renderer/components/Roster.tsx` (MODIFY) — mount `<AgentShelf>` above the toolbar.
- `src/renderer/App.tsx` (MODIFY) — render the run drawer + editor; pass roster/agents.
- `src/renderer/styles.css` (MODIFY) — shelf/row/popover/editor/drawer styles.
- `test/e2e/crew.e2e.mjs` (MODIFY) — e2e for run + save-to-assets.

---

### Task 1: Types + pure agent helpers

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/agents.ts`
- Test: `test/agents.test.ts`

**Interfaces:**
- Produces:
  - `Agent { id, name, icon, color?, base, persona, contextMode: 'cwd'|'cwd+transcript', writes: boolean, order, builtin? }`
  - `AgentRun { id, agentId, sessionId: string|null, cwd, task, status:'running'|'done'|'error', output, startedAt, endedAt?, error? }`
  - `makeAgentId(): string`, `makeRunId(): string`
  - `BUILTIN_AGENTS: Agent[]`
  - `buildAgentInvocation(base: {command:string; args:string[]}, agent: Agent, task: string, extra: string): { args: string[] }` — returns the argv **after** the base command (the runner spawns `base.command` with `[...base.args, ...result.args]`).
  - `validateAgent(a: Partial<Agent>): string | null` (error message or null)
  - `upsertAgent(list: Agent[], a: Agent): Agent[]`, `deleteAgent(list, id): Agent[]`, `reorderAgents(list, ids): Agent[]`

- [ ] **Step 1: Write failing tests** — create `test/agents.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  makeAgentId, makeRunId, BUILTIN_AGENTS, buildAgentInvocation,
  validateAgent, upsertAgent, deleteAgent, reorderAgents
} from '../src/shared/agents'
import type { Agent } from '../src/shared/types'

const ag = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag_test', name: 'UX Critique', icon: 'spark', base: 'copilot-cli',
  persona: 'You are a UX critic. Do not edit files.', contextMode: 'cwd',
  writes: false, order: 0, ...over
})

describe('ids', () => {
  it('mints unique prefixed ids', () => {
    expect(makeAgentId()).toMatch(/^ag_[a-z0-9]{6,}$/)
    expect(makeRunId()).toMatch(/^run_[a-z0-9]{6,}$/)
    expect(makeAgentId()).not.toBe(makeAgentId())
  })
})

describe('BUILTIN_AGENTS', () => {
  it('ships several read-first specialists with unique ids + order', () => {
    expect(BUILTIN_AGENTS.length).toBeGreaterThanOrEqual(3)
    expect(new Set(BUILTIN_AGENTS.map((a) => a.id)).size).toBe(BUILTIN_AGENTS.length)
    expect(BUILTIN_AGENTS.every((a) => a.builtin)).toBe(true)
    expect(BUILTIN_AGENTS.some((a) => a.name === 'UX Critique')).toBe(true)
  })
})

describe('buildAgentInvocation (copilot)', () => {
  const base = { command: 'copilot', args: [] }
  it('read-first: -p prompt, deny write tools, no --allow-all-tools', () => {
    const { args } = buildAgentInvocation(base, ag({ writes: false }), 'Review the checkout', '')
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('You are a UX critic')
    expect(args[1]).toContain('Review the checkout')
    expect(args).toContain('--deny-tool')
    expect(args).not.toContain('--allow-all-tools')
  })
  it('writes: grants --allow-all-tools', () => {
    const { args } = buildAgentInvocation(base, ag({ writes: true }), 'Write docs', '')
    expect(args).toContain('--allow-all-tools')
  })
  it('appends extra context when provided', () => {
    const { args } = buildAgentInvocation(base, ag(), 'T', 'RECENT TRANSCRIPT')
    expect(args[1]).toContain('RECENT TRANSCRIPT')
  })
})

describe('buildAgentInvocation (claude)', () => {
  const base = { command: 'claude', args: [] }
  it('uses -p and text output, disallows edits when read-first', () => {
    const { args } = buildAgentInvocation(base, ag({ base: 'claude-code', writes: false }), 'T', '')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('text')
    expect(args).toContain('--disallowedTools')
  })
})

describe('validate/crud', () => {
  it('rejects blank name/persona', () => {
    expect(validateAgent({ name: '', persona: 'x', base: 'copilot-cli' })).toBeTruthy()
    expect(validateAgent({ name: 'x', persona: '', base: 'copilot-cli' })).toBeTruthy()
    expect(validateAgent(ag())).toBeNull()
  })
  it('upsert/delete/reorder by id', () => {
    const a = ag({ id: 'ag_a', order: 0 }), b = ag({ id: 'ag_b', order: 1 })
    expect(upsertAgent([a], { ...a, name: 'X' }).find((x) => x.id === 'ag_a')?.name).toBe('X')
    expect(upsertAgent([a], b).map((x) => x.id)).toEqual(['ag_a', 'ag_b'])
    expect(deleteAgent([a, b], 'ag_a').map((x) => x.id)).toEqual(['ag_b'])
    expect(reorderAgents([a, b], ['ag_b', 'ag_a']).map((x) => [x.id, x.order])).toEqual([['ag_b', 0], ['ag_a', 1]])
  })
})
```

- [ ] **Step 2: Run to verify fail** — `export PATH="…" && npx vitest run test/agents.test.ts` → FAIL (module missing).

- [ ] **Step 3: Add types** to `src/shared/types.ts` (before `export interface Workspace`):

```ts
/** A reusable specialist agent invoked headless against a session's context. */
export interface Agent {
  id: string
  name: string
  icon: string            // an Icon name (geometric, not an animal mascot)
  color?: string
  base: string            // preset id providing the CLI/brain: 'copilot-cli' | 'claude-code'
  persona: string         // system/prefix prompt
  contextMode: 'cwd' | 'cwd+transcript'
  writes: boolean         // true = may edit files (full autonomy); false = read-first
  order: number
  builtin?: boolean
}

/** A single headless invocation of an agent (transient; last-per-agent kept). */
export interface AgentRun {
  id: string
  agentId: string
  sessionId: string | null
  cwd: string
  task: string
  status: 'running' | 'done' | 'error'
  output: string
  startedAt: number
  endedAt?: number
  error?: string
}
```

Add IPC consts to the `IPC` object (near `SESSION_DESCRIBE`):

```ts
  AGENTS_GET: 'agents:get',
  AGENT_UPSERT: 'agent:upsert',
  AGENT_DELETE: 'agent:delete',
  AGENTS_REORDER: 'agents:reorder',
  AGENT_RUN: 'agent:run',
  AGENT_RUN_CANCEL: 'agent:runCancel',
  AGENT_SAVE_RESULT: 'agent:saveResult',
  EVT_AGENTS: 'evt:agents',
  EVT_AGENT_RUN: 'evt:agentRun',
```

- [ ] **Step 4: Implement `src/shared/agents.ts`:**

```ts
import type { Agent } from './types'

export function makeAgentId(): string {
  return 'ag_' + Math.random().toString(36).slice(2, 10)
}
export function makeRunId(): string {
  return 'run_' + Math.random().toString(36).slice(2, 10)
}

/** Built-in specialists. Read-first personas explicitly forbid edits. */
export const BUILTIN_AGENTS: Agent[] = [
  { id: 'ag_ux', name: 'UX Critique', icon: 'spark', color: '#c879ff', base: 'copilot-cli', writes: false, contextMode: 'cwd', order: 0, builtin: true,
    persona: 'You are a senior product designer doing a UX critique. Inspect the app/code in this working directory (read only — do NOT edit any files). Report the top usability, hierarchy, accessibility and copy issues, each with a concrete fix. Be specific and concise.' },
  { id: 'ag_review', name: 'Code Review', icon: 'check', color: '#3fb950', base: 'copilot-cli', writes: false, contextMode: 'cwd', order: 1, builtin: true,
    persona: 'You are a meticulous staff engineer. Review the recent changes in this repository (read only — do NOT edit). Report high-confidence correctness bugs, risky logic, and design issues, with file references. Skip style nits.' },
  { id: 'ag_sec', name: 'Security Review', icon: 'shield', color: '#e5a13a', base: 'copilot-cli', writes: false, contextMode: 'cwd', order: 2, builtin: true,
    persona: 'You are an application security reviewer. Read the code in this working directory (read only — do NOT edit). Report only high-confidence, exploitable vulnerabilities with severity, location and remediation.' },
  { id: 'ag_docs', name: 'Doc Writer', icon: 'doc', color: '#5f79ff', base: 'copilot-cli', writes: true, contextMode: 'cwd', order: 3, builtin: true,
    persona: 'You are a technical writer. Draft or update clear documentation for the code in this working directory. Prefer a concise README/section with usage examples.' }
]

// Copilot tools that write/mutate — denied for read-first agents so a headless
// run never edits files and never blocks on an approval prompt.
const COPILOT_WRITE_TOOLS = ['write', 'edit', 'shell']
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'Bash']

function buildPrompt(agent: Agent, task: string, extra: string): string {
  const parts = [agent.persona]
  if (task.trim()) parts.push('Task: ' + task.trim())
  if (extra.trim()) parts.push('Context:\n' + extra.trim())
  return parts.join('\n\n')
}

/**
 * Argv (after the base command) for a headless one-shot run. copilot/claude both
 * print and exit under -p. Read-first agents deny write tools; writes agents get
 * full autonomy so nothing blocks on approval.
 */
export function buildAgentInvocation(
  base: { command: string; args: string[] },
  agent: Agent,
  task: string,
  extra: string
): { args: string[] } {
  const prompt = buildPrompt(agent, task, extra)
  const cmd = base.command
  if (cmd.includes('claude')) {
    const args = ['-p', prompt, '--output-format', 'text']
    if (agent.writes) args.push('--dangerously-skip-permissions')
    else args.push('--disallowedTools', CLAUDE_WRITE_TOOLS.join(','))
    return { args }
  }
  // default: copilot-style
  const args = ['-p', prompt]
  if (agent.writes) args.push('--allow-all-tools')
  else args.push('--allow-all-paths', '--deny-tool', COPILOT_WRITE_TOOLS.join(','))
  return { args }
}

export function validateAgent(a: Partial<Agent>): string | null {
  if (!a.name || !a.name.trim()) return 'Name is required.'
  if (!a.persona || !a.persona.trim()) return 'Persona is required.'
  if (!a.base) return 'A base agent is required.'
  return null
}

export function upsertAgent(list: readonly Agent[], a: Agent): Agent[] {
  const exists = list.some((x) => x.id === a.id)
  return exists ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]
}
export function deleteAgent(list: readonly Agent[], id: string): Agent[] {
  return list.filter((x) => x.id !== id)
}
export function reorderAgents(list: readonly Agent[], orderedIds: readonly string[]): Agent[] {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  return list.map((a) => ({ ...a, order: rank.has(a.id) ? (rank.get(a.id) as number) : a.order })).sort((x, y) => x.order - y.order)
}
```

> **Spike note (finalize in Task 3 Step 1):** the exact copilot `--deny-tool` / claude `--disallowedTools` token names must be confirmed against the installed CLIs (`copilot --help`, `claude --help`, plus a read-only probe). Adjust `COPILOT_WRITE_TOOLS` / `CLAUDE_WRITE_TOOLS` to the real identifiers; the tests assert the *flag* is present, not the exact tokens, so they stay green.

- [ ] **Step 5: Run tests** — `npx vitest run test/agents.test.ts && npm run typecheck` → PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/agents.ts src/shared/types.ts test/agents.test.ts
git commit -m "feat(agents): Agent/AgentRun types + pure invocation & seed helpers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 2: Store — persist agents + seed built-ins

**Files:**
- Modify: `src/main/store.ts`
- Test: `test/store-migrations.test.ts`

**Interfaces:**
- Consumes: `Agent`, `BUILTIN_AGENTS` from `src/shared/agents`.
- Produces: `Store.getAgents(): Agent[]`, `Store.saveAgents(list: Agent[]): Agent[]`; migration `2026-08-agents-seed`.

- [ ] **Step 1: Failing migration test** — append to `test/store-migrations.test.ts`:

```ts
describe('store migration — seed built-in agents', () => {
  const ID = '2026-08-agents-seed'
  it('seeds built-in agents on an existing store missing them', () => {
    const p = tmpStorePath()
    seed(p, { sessions: [], migrations: [] })
    const store = new Store(p)
    const agents = store.getAgents()
    expect(agents.length).toBeGreaterThanOrEqual(3)
    expect(agents.some((a) => a.name === 'UX Critique')).toBe(true)
    const persisted = JSON.parse(readFileSync(p, 'utf8'))
    expect(persisted.migrations).toContain(ID)
  })
  it('does not duplicate seeds once present', () => {
    const p = tmpStorePath()
    seed(p, { agents: [{ id: 'ag_x', name: 'Mine', icon: 'spark', base: 'copilot-cli', persona: 'p', contextMode: 'cwd', writes: false, order: 0 }], migrations: [ID] })
    const store = new Store(p)
    expect(store.getAgents().map((a) => a.id)).toEqual(['ag_x'])
  })
})
```

- [ ] **Step 2: Run to verify fail** — `npx vitest run test/store-migrations.test.ts` → FAIL (`getAgents` undefined).

- [ ] **Step 3: Add store field + getters** — in `src/main/store.ts`: import `import { BUILTIN_AGENTS } from '../shared/agents'` and `import type { Agent } from '../shared/types'` (extend an existing type import). Add `agents: Agent[]` to `StoreData`; `EMPTY.agents = []`; in `load()`'s `data` add `agents: raw.agents ?? []`; in the corrupt-fallback baseline add `agents: []`. Add:

```ts
getAgents(): Agent[] {
  return this.data.agents
}
saveAgents(list: Agent[]): Agent[] {
  this.data.agents = list
  this.persist()
  return this.data.agents
}
```

- [ ] **Step 4: Add the seed migration** — append to `MIGRATIONS`:

```ts
{
  // Seed the built-in specialist agents once. Users can edit/delete them after.
  id: '2026-08-agents-seed',
  apply: (d) => {
    if ((d.agents?.length ?? 0) > 0) return
    d.agents = BUILTIN_AGENTS.map((a) => ({ ...a }))
  }
}
```

Also add `agents: []` to the `EMPTY` constant and the corrupt-fallback baseline object. (On a *fresh* install the baseline marks all migrations applied, so also set `agents: BUILTIN_AGENTS.map((a) => ({ ...a }))` in that fresh baseline so new users still get the built-ins.)

- [ ] **Step 5: Run tests** — `npx vitest run test/store-migrations.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/store.ts test/store-migrations.test.ts
git commit -m "feat(store): persist agents + seed built-in specialists

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 3: Headless run engine — `agent-runner.ts`

**Files:**
- Create: `src/main/agent-runner.ts`
- Test: `test/agent-runner.test.ts`

**Interfaces:**
- Consumes: `buildAgentInvocation`, `makeRunId` from `../shared/agents`; `Agent`, `AgentRun` types.
- Produces: `class AgentRunner extends EventEmitter` with:
  - `constructor(resolveBase: (baseId: string) => { command: string; args: string[] } | null)`
  - `run(agent: Agent, ctx: { sessionId: string | null; cwd: string; task: string; extra?: string }): AgentRun`
  - `cancel(runId: string): void`
  - `get(runId: string): AgentRun | undefined`
  - events: `'run'` emits the full `AgentRun` on every state change (start, throttled output, done/error).
  - Options: `timeoutMs = 180000`, `maxOutput = 200000` (module consts).

- [ ] **Step 1: Feasibility spike (finalize tool flags).** Run and record behavior:

```bash
tmp=$(mktemp -d); echo '<h1>hi</h1>' > "$tmp/index.html"
copilot -p "List the files here and summarize index.html. Do not edit anything." -C "$tmp" --allow-all-paths --deny-tool write,edit,shell 2>&1 | head -20
claude -p "List the files here." --output-format text --disallowedTools Write,Edit,Bash 2>&1 | head -20
```
Confirm each **completes without prompting** and prints a result. If a token name is wrong (error about unknown tool), adjust `COPILOT_WRITE_TOOLS`/`CLAUDE_WRITE_TOOLS` in `src/shared/agents.ts` to the correct identifiers and re-run `npx vitest run test/agents.test.ts`.

- [ ] **Step 2: Write failing runner test** — create `test/agent-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AgentRunner } from '../src/main/agent-runner'
import type { Agent } from '../src/shared/types'

const agent: Agent = { id: 'ag_t', name: 'Echo', icon: 'spark', base: 'fake', persona: 'p', contextMode: 'cwd', writes: false, order: 0 }

// A fake base: node that prints its last arg (the prompt) then exits 0.
const resolveBase = () => ({ command: process.execPath, args: ['-e', 'process.stdout.write("RESULT:"+process.argv[process.argv.length-1])'] })

describe('AgentRunner', () => {
  it('runs headless, streams output, ends done with the result', async () => {
    const r = new AgentRunner(resolveBase)
    const updates: string[] = []
    r.on('run', (run) => updates.push(run.status))
    const run = r.run(agent, { sessionId: 's1', cwd: process.cwd(), task: 'hello', extra: '' })
    expect(run.status).toBe('running')
    await new Promise((res) => r.on('run', (u) => u.id === run.id && u.status !== 'running' && res(null)))
    const final = r.get(run.id)!
    expect(final.status).toBe('done')
    expect(final.output).toContain('RESULT:')
    expect(final.output).toContain('hello')
    expect(updates).toContain('done')
  })
  it('cancel marks a run errored', async () => {
    const slow = () => ({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] })
    const r = new AgentRunner(slow)
    const run = r.run(agent, { sessionId: null, cwd: process.cwd(), task: '', extra: '' })
    r.cancel(run.id)
    await new Promise((res) => setTimeout(res, 300))
    expect(r.get(run.id)!.status).toBe('error')
  })
})
```

- [ ] **Step 3: Run to verify fail** — `npx vitest run test/agent-runner.test.ts` → FAIL.

- [ ] **Step 4: Implement `src/main/agent-runner.ts`:**

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { buildAgentInvocation, makeRunId } from '../shared/agents'
import type { Agent, AgentRun } from '../shared/types'

const TIMEOUT_MS = 180000
const MAX_OUTPUT = 200000

interface Rec { run: AgentRun; child: ChildProcess; timer: NodeJS.Timeout }

/** Owns headless one-shot agent runs. Spawns the base CLI in print mode, streams
 *  stdout into a transient AgentRun, and emits 'run' on every change. */
export class AgentRunner extends EventEmitter {
  private readonly recs = new Map<string, Rec>()

  constructor(private readonly resolveBase: (baseId: string) => { command: string; args: string[] } | null) {
    super()
  }

  get(runId: string): AgentRun | undefined {
    return this.recs.get(runId)?.run
  }

  run(agent: Agent, ctx: { sessionId: string | null; cwd: string; task: string; extra?: string }): AgentRun {
    const base = this.resolveBase(agent.base)
    const run: AgentRun = {
      id: makeRunId(), agentId: agent.id, sessionId: ctx.sessionId, cwd: ctx.cwd,
      task: ctx.task, status: 'running', output: '', startedAt: Date.now()
    }
    if (!base) {
      run.status = 'error'; run.error = `Unknown base agent "${agent.base}".`; run.endedAt = Date.now()
      this.recs.set(run.id, { run, child: null as unknown as ChildProcess, timer: null as unknown as NodeJS.Timeout })
      queueMicrotask(() => this.emit('run', { ...run }))
      return run
    }
    const { args } = buildAgentInvocation(base, agent, ctx.task, ctx.extra ?? '')
    let child: ChildProcess
    try {
      child = spawn(base.command, [...base.args, ...args], {
        cwd: ctx.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
      })
    } catch (err) {
      run.status = 'error'; run.error = err instanceof Error ? err.message : String(err); run.endedAt = Date.now()
      this.recs.set(run.id, { run, child: null as unknown as ChildProcess, timer: null as unknown as NodeJS.Timeout })
      queueMicrotask(() => this.emit('run', { ...run }))
      return run
    }
    const timer = setTimeout(() => this.kill(run.id, 'Timed out.'), TIMEOUT_MS)
    this.recs.set(run.id, { run, child, timer })
    const append = (buf: Buffer): void => {
      run.output = (run.output + buf.toString()).slice(-MAX_OUTPUT)
      this.emit('run', { ...run })
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (run.status === 'running') {
        run.status = code === 0 ? 'done' : 'error'
        if (code !== 0 && !run.error) run.error = `Exited with code ${code}.`
        run.endedAt = Date.now()
        this.emit('run', { ...run })
      }
    })
    queueMicrotask(() => this.emit('run', { ...run }))
    return run
  }

  cancel(runId: string): void {
    this.kill(runId, 'Cancelled.')
  }

  private kill(runId: string, reason: string): void {
    const rec = this.recs.get(runId)
    if (!rec || rec.run.status !== 'running') return
    rec.run.status = 'error'; rec.run.error = reason; rec.run.endedAt = Date.now()
    clearTimeout(rec.timer)
    try { if (rec.child?.pid && rec.child.pid > 0) process.kill(-rec.child.pid, 'SIGTERM') } catch { /* gone */ }
    this.emit('run', { ...rec.run })
  }

  disposeAll(): void {
    for (const id of this.recs.keys()) this.kill(id, 'Shutting down.')
  }
}
```

- [ ] **Step 5: Run tests** — `npx vitest run test/agent-runner.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent-runner.ts test/agent-runner.test.ts src/shared/agents.ts
git commit -m "feat(agents): headless run engine (spawn/stream/cancel/timeout)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 4: IPC + preload + api + save-to-assets

**Files:**
- Modify: `src/main/index.ts`, `src/preload/index.ts`, `src/shared/api.ts`

**Interfaces:**
- Produces `CrewAPI`:
  - `getAgents(): Promise<Agent[]>`
  - `upsertAgent(a: Agent): Promise<Agent[]>`
  - `deleteAgent(id: string): Promise<Agent[]>`
  - `reorderAgents(ids: string[]): Promise<Agent[]>`
  - `runAgent(agentId: string, sessionId: string | null, task: string): Promise<AgentRun>`
  - `cancelAgentRun(runId: string): Promise<void>`
  - `saveAgentResult(runId: string): Promise<{ ok: boolean; path?: string; error?: string }>`
  - `onAgents(cb: (list: Agent[]) => void): Unsubscribe`
  - `onAgentRun(cb: (run: AgentRun) => void): Unsubscribe`

- [ ] **Step 1: Extend `CrewAPI`** in `src/shared/api.ts` (import `Agent, AgentRun` from `./types`) with the signatures above (methods near `setSessionDescription`; subscriptions near `onWorkspaces`).

- [ ] **Step 2: Instantiate the runner + handlers** in `src/main/index.ts`. Near where `manager`/`store` exist, add:

```ts
import { AgentRunner } from './agent-runner'
import { makeAgentId, upsertAgent as upsertAgentList, deleteAgent as deleteAgentList, reorderAgents as reorderAgentList } from '../shared/agents'
import { getPreset } from './presets'
```

Create the runner once (after `store`/`manager` are constructed):

```ts
const agentRunner = new AgentRunner((baseId) => {
  const p = getPreset(baseId)
  return p ? { command: p.command, args: p.args } : null
})
agentRunner.on('run', (run) => broadcast(IPC.EVT_AGENT_RUN, run))
```

In `registerIpc()` add:

```ts
const pushAgents = () => { const l = store.getAgents(); broadcast(IPC.EVT_AGENTS, l); return l }
ipcMain.handle(IPC.AGENTS_GET, () => store.getAgents())
ipcMain.handle(IPC.AGENT_UPSERT, (_e, a: Agent) => { store.saveAgents(upsertAgentList(store.getAgents(), a.id ? a : { ...a, id: makeAgentId() })); return pushAgents() })
ipcMain.handle(IPC.AGENT_DELETE, (_e, id: string) => { store.saveAgents(deleteAgentList(store.getAgents(), id)); return pushAgents() })
ipcMain.handle(IPC.AGENTS_REORDER, (_e, ids: string[]) => { store.saveAgents(reorderAgentList(store.getAgents(), ids)); return pushAgents() })
ipcMain.handle(IPC.AGENT_RUN, (_e, p: { agentId: string; sessionId: string | null; task: string }) => {
  const agent = store.getAgents().find((a) => a.id === p.agentId)
  if (!agent) return { id: '', agentId: p.agentId, sessionId: p.sessionId, cwd: '', task: p.task, status: 'error', output: '', startedAt: Date.now(), error: 'Agent not found.' }
  // Resolve the target cwd from the session; refuse to run against $HOME with no session.
  const s = p.sessionId ? manager.roster().find((x) => x.id === p.sessionId) : null
  const cwd = s?.cwd ?? ''
  if (!cwd || cwd === homedir()) return { id: '', agentId: p.agentId, sessionId: p.sessionId, cwd, task: p.task, status: 'error', output: '', startedAt: Date.now(), error: 'Pick a session with a project folder to run against.' }
  return agentRunner.run(agent, { sessionId: p.sessionId, cwd, task: p.task })
})
ipcMain.handle(IPC.AGENT_RUN_CANCEL, (_e, runId: string) => agentRunner.cancel(runId))
ipcMain.handle(IPC.AGENT_SAVE_RESULT, async (_e, runId: string) => {
  const run = agentRunner.get(runId)
  if (!run || !run.cwd) return { ok: false, error: 'No result to save.' }
  const agent = store.getAgents().find((a) => a.id === run.agentId)
  const slug = (agent?.name ?? 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const dir = join(run.cwd, 'agents')
  const file = join(dir, `${slug}-${new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}.md`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, `# ${agent?.name ?? 'Agent'} — ${run.task || 'run'}\n\n${run.output}\n`)
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})
```

Ensure imports at top of `index.ts`: `homedir` from `node:os`, `join` from `node:path`, `mkdir, writeFile` from `node:fs/promises` (add if not present). Add `agentRunner.disposeAll()` to the app shutdown/cleanup path (where the manager is disposed).

> The saved file lands under the session's `cwd/agents/…`, which the existing `AssetWatchers` picks up automatically, so it appears in the session's Assets pane.

- [ ] **Step 3: Wire preload** in `src/preload/index.ts`:

```ts
  getAgents: () => ipcRenderer.invoke(IPC.AGENTS_GET),
  upsertAgent: (a) => ipcRenderer.invoke(IPC.AGENT_UPSERT, a),
  deleteAgent: (id) => ipcRenderer.invoke(IPC.AGENT_DELETE, id),
  reorderAgents: (ids) => ipcRenderer.invoke(IPC.AGENTS_REORDER, ids),
  runAgent: (agentId, sessionId, task) => ipcRenderer.invoke(IPC.AGENT_RUN, { agentId, sessionId, task }),
  cancelAgentRun: (runId) => ipcRenderer.invoke(IPC.AGENT_RUN_CANCEL, runId),
  saveAgentResult: (runId) => ipcRenderer.invoke(IPC.AGENT_SAVE_RESULT, runId),
  onAgents: (cb) => subscribe(IPC.EVT_AGENTS, cb),
  onAgentRun: (cb) => subscribe(IPC.EVT_AGENT_RUN, cb),
```

- [ ] **Step 4: Verify + commit** — `npm run typecheck && npm run build` clean.

```bash
git add src/shared/api.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(agents): IPC for agent CRUD, headless run, and save-to-assets

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 5: Renderer state (hooks)

**Files:**
- Modify: `src/renderer/hooks.ts`

**Interfaces:**
- Produces on the hook return: `agents: Agent[]`, `runs: Record<string, AgentRun>` (keyed by run id), `activeRunId: string | null`, `setActiveRunId`, `editingAgentId: string | null | 'new'`, `setEditingAgent`.

- [ ] **Step 1: Add state + subscriptions.** In `hooks.ts`:

```ts
const [agents, setAgents] = useState<Agent[]>([])
const [runs, setRuns] = useState<Record<string, AgentRun>>({})
const [activeRunId, setActiveRunId] = useState<string | null>(null)
const [editingAgent, setEditingAgent] = useState<string | null | 'new'>(null)
```

In the mount effect add:

```ts
void window.crew.getAgents().then((a) => mounted && setAgents(a))
const offAgents = window.crew.onAgents((a) => setAgents(a))
const offAgentRun = window.crew.onAgentRun((run) => {
  setRuns((prev) => ({ ...prev, [run.id]: run }))
  setActiveRunId((cur) => cur ?? run.id) // surface the drawer on first run
})
```

Add `offAgents(); offAgentRun()` to cleanup. Import `Agent, AgentRun` from `../shared/types`. Add `agents, runs, activeRunId, setActiveRunId, editingAgent, setEditingAgent` to the return object + its `CrewState` interface.

- [ ] **Step 2: Verify + commit** — `npm run typecheck` clean.

```bash
git add src/renderer/hooks.ts
git commit -m "feat(agents): renderer state for agents + runs + drawer/editor

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 6: Nav Agents shelf (`AgentShelf` + `AgentRow`)

**Files:**
- Create: `src/renderer/components/AgentShelf.tsx`, `src/renderer/components/AgentRow.tsx`
- Modify: `src/renderer/components/Roster.tsx`, `src/renderer/components/Icon.tsx` (add `spark`, `check`, `shield`, `doc` glyphs), `src/renderer/styles.css`

**Interfaces:**
- `AgentShelf` props: `{ agents: Agent[]; runs: Record<string, AgentRun>; railed: boolean; onInvoke: (agentId: string) => void; onAddAgent: () => void }`.
- `AgentRow` props: `{ agent: Agent; running: boolean; railed: boolean; onInvoke: () => void }`.

- [ ] **Step 1: Add Icon glyphs** — in `src/renderer/components/Icon.tsx` add `'spark' | 'check' | 'shield' | 'doc'` to the name union and Feather-style paths (e.g. `spark`: a 4-point star; `check`: a checkmark in a circle; `shield`: a shield outline; `doc`: a document). Provide complete `<path>` markup for each in the `PATHS` record.

- [ ] **Step 2: Implement `AgentRow.tsx`** — a button row: the agent's `Icon` (tinted with `agent.color`), the name (hidden when `railed`), a spinner when `running`, and a "can edit" dot when `agent.writes`. `onClick={onInvoke}`. Root class `agent-row`.

- [ ] **Step 3: Implement `AgentShelf.tsx`** — a `<section className="agent-shelf">` with a header ("Agents" label + a `+` button calling `onAddAgent`, hidden when railed) and the rows (each `running` = any run with `status==='running'` and `agentId===agent.id`). Provide full component code.

- [ ] **Step 4: Mount in `Roster.tsx`** — render `<AgentShelf agents={agents} runs={runs} railed={railed} onInvoke={onInvokeAgent} onAddAgent={onAddAgent} />` immediately **above** `<div className="roster__toolbar">`. Add the four props (`agents`, `runs`, `onInvokeAgent`, `onAddAgent`) to Roster's Props and thread them from `App.tsx`.

- [ ] **Step 5: CSS** — `.agent-shelf` (top border, small label), `.agent-row` (flex, icon + name, hover, `.is-running` spinner, `.can-write` dot), railed variants (icon-only). Reuse theme vars.

- [ ] **Step 6: Verify + commit** — `npm run typecheck && npm run build` clean.

```bash
git add src/renderer/components/AgentShelf.tsx src/renderer/components/AgentRow.tsx src/renderer/components/Roster.tsx src/renderer/components/Icon.tsx src/renderer/styles.css
git commit -m "feat(agents): nav Agents shelf with distinct specialist icons

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 7: Invoke popover + Agent editor

**Files:**
- Create: `src/renderer/components/AgentInvoke.tsx`, `src/renderer/components/AgentEditor.tsx`
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- `AgentInvoke` props: `{ agent: Agent; sessions: SessionInfo[]; defaultSessionId: string | null; onRun: (sessionId: string, task: string) => void; onClose: () => void }`.
- `AgentEditor` props: `{ agent: Agent | null; presets: Preset[]; onSave: (a: Agent) => void; onDelete?: (id: string) => void; onClose: () => void }` (null = create).

- [ ] **Step 1: `AgentInvoke.tsx`** — a modal/popover: a session `<select>` (defaults to `defaultSessionId`, options = active sessions with a cwd), a task `<textarea>` ("What should {agent.name} look at? (optional)"), and Run/Cancel. On Run calls `onRun(sessionId, task)`. If `agent.writes`, show a "⚠ This agent can edit files" line. Provide full code.

- [ ] **Step 2: `AgentEditor.tsx`** — a modal form: name, base `<select>` (from `presets` where the preset is an agent CLI, i.e. `copilot-cli`/`claude-code`), icon `<select>` (spark/check/shield/doc), color, persona `<textarea>`, contextMode `<select>` (cwd / cwd+transcript), and a "Can edit files (autonomous)" checkbox → `writes`. Validate with `validateAgent` before `onSave`. For a built-in, allow duplicate ("Save as copy") but not delete. Provide full code.

- [ ] **Step 3: Wire into `App.tsx`** — hold invoke target in local state (`invokeAgentId`), render `<AgentInvoke>` when set (agent found in `c.agents`), and `<AgentEditor>` when `c.editingAgent !== null`. `onRun` → `window.crew.runAgent(agentId, sessionId, task)` then close + `c.setActiveRunId` is set by the run event. `onSave` → `window.crew.upsertAgent(a)`. Pass `onInvokeAgent={(id) => setInvokeAgentId(id)}` and `onAddAgent={() => c.setEditingAgent('new')}` to Roster. Add a command-palette entry "Run a specialist…" listing agents. Add `|| invokeAgentId !== null || c.editingAgent !== null` to `anyOverlay`.

- [ ] **Step 4: Verify + commit** — `npm run typecheck && npm run build` clean.

```bash
git add src/renderer/components/AgentInvoke.tsx src/renderer/components/AgentEditor.tsx src/renderer/App.tsx
git commit -m "feat(agents): invoke popover + agent editor

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 8: Result drawer (`AgentRunPanel`)

**Files:**
- Create: `src/renderer/components/AgentRunPanel.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`

**Interfaces:**
- `AgentRunPanel` props: `{ run: AgentRun; agent: Agent | undefined; onCancel: () => void; onInsert: () => void; onSave: () => void; onClose: () => void }`.

- [ ] **Step 1: `AgentRunPanel.tsx`** — a right-side drawer: header (agent name + status: Running w/ spinner / Done / Error), a scrolling `<pre className="agent-run__out">` streaming `run.output`, and a footer of actions: **Cancel** (while running), and when `status==='done'`: **Copy** (`navigator.clipboard.writeText(run.output)`), **Insert into session** (`onInsert`), **Save to Assets** (`onSave`). Provide full code.

- [ ] **Step 2: Wire into `App.tsx`** — render `{c.activeRunId && c.runs[c.activeRunId] && (<AgentRunPanel run={c.runs[c.activeRunId]} agent={c.agents.find(a=>a.id===c.runs[c.activeRunId].agentId)} onCancel={() => window.crew.cancelAgentRun(c.activeRunId)} onInsert={() => { const r=c.runs[c.activeRunId]; if(r.sessionId) window.crew.sendInput(r.sessionId, r.output) }} onSave={() => window.crew.saveAgentResult(c.activeRunId)} onClose={() => c.setActiveRunId(null)} />)}`. Add `|| c.activeRunId !== null` to `anyOverlay` only if it should block shortcuts (it's a drawer, so it need NOT be a full overlay — keep it non-blocking).

- [ ] **Step 3: CSS** — `.agent-run` drawer (fixed right, width ~420px, slide-in), `.agent-run__out` (mono, pre-wrap, scroll), `.agent-run__foot` action row, status chip styles. Reuse theme vars.

- [ ] **Step 4: Verify + commit** — `npm run typecheck && npm run build` clean.

```bash
git add src/renderer/components/AgentRunPanel.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(agents): streaming result drawer (copy / insert / save-to-assets)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 9: E2E + guide screenshot + full verify

**Files:**
- Modify: `test/e2e/crew.e2e.mjs`, `test/e2e/guide-shots.mjs`

- [ ] **Step 1: E2E section** in `crew.e2e.mjs` (after the Workspaces section). Because the real CLIs aren't available in CI, first replace one seeded agent's `base` with a **fake preset**: add a hidden test hook — simplest is to test the pieces that don't need a real CLI:
  - `window.crew.getAgents()` returns the seeded built-ins (assert `UX Critique` present).
  - `upsertAgent` a custom agent whose `base:'shell'` and `persona` set; assert it appears via `getAgents()`.
  - `runAgent(customId, <a session id with a real cwd>, 'echo hi')` — since `base:'shell'` resolves to the shell, the run will spawn a shell in print-ish mode; assert an `EVT_AGENT_RUN` arrives and the run reaches a terminal `status` (done or error) without hanging. Assert 0 renderer errors.

```js
log('Agents (headless specialists)')
const agents0 = await page.evaluate(async () => window.crew.getAgents())
if (agents0.some((a) => a.name === 'UX Critique')) ok('built-in specialists seeded'); else bad('no built-in agents')
const sid = await page.evaluate(async () => (await window.crew.getRoster())[0]?.id)
const custom = await page.evaluate(async () => window.crew.upsertAgent({ id: '', name: 'Echo Spec', icon: 'spark', base: 'shell', persona: 'echo hello from spec', contextMode: 'cwd', writes: false, order: 99 }))
const echoId = custom.find((a) => a.name === 'Echo Spec')?.id
if (echoId) ok('custom agent created'); else bad('upsertAgent failed')
let sawRun = false
await page.evaluate(async ({ id, sid }) => { window.__lastRun = null; window.crew.onAgentRun((r) => { window.__lastRun = r }); await window.crew.runAgent(id, sid, 'print a greeting') }, { id: echoId, sid })
await waitUntil(async () => page.evaluate(() => window.__lastRun && window.__lastRun.status && window.__lastRun.status !== 'running'), 'agent run reaches terminal state', 15000).then(() => { sawRun = true }).catch(() => {})
if (sawRun) ok('agent run streams to a terminal state (no hang)'); else bad('agent run did not finish')
```

> Note: `base:'shell'` resolves via `getPreset('shell')`; `buildAgentInvocation` for a non-copilot/non-claude command falls into the copilot branch and appends `-p`/flags the shell won't understand — so the shell will exit non-zero quickly (status `error`), which still satisfies "reaches a terminal state without hanging." If you prefer a clean `done`, add a tiny `base:'echo'` preset in `presets.ts` guarded to test builds, or assert `status` ∈ {done,error}.

- [ ] **Step 2: Guide screenshot** in `guide-shots.mjs` — after the workspaces capture, screenshot the nav with the Agents shelf visible (`full('agents.png')` after ensuring the sidebar is expanded), then invoke a seeded agent against a staged session and capture the result drawer. Convert to `docs/assets/guide/agents.jpg` (1600×1000) as in prior guide shots. (A guide.html section can follow.)

- [ ] **Step 3: Full verification**

```
export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH"
npm run typecheck && npx vitest run && npm run build && node test/e2e/crew.e2e.mjs
```
Expected: typecheck clean, all unit tests pass, build succeeds, e2e ✅ PASSED (0 assertion/renderer errors).

- [ ] **Step 4: Live probe** — a throwaway Playwright script: launch the built app, confirm the Agents shelf renders the seeded specialists at the bottom of the nav with distinct icons, open the invoke popover, and (using a `base:'shell'`/echo agent against a staged session) confirm the result drawer streams and "Save to Assets" writes a note that appears in the Assets pane. Screenshot `/tmp/agents.png`, view it, delete the probe.

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "test(agents): e2e coverage for seeded specialists + headless run

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
export TK=$(gh auth token --user alexselig)
git -c credential.helper= -c credential.helper='!f(){ echo username=alexselig; echo "password=$TK"; }; f' push origin main
```

---

## Self-Review

**Spec coverage:**
- First-class Agent definition (name/icon/base/persona/contextMode/writes) → Task 1. ✓
- Agents shelf at the bottom of the nav, distinct icons → Task 6. ✓
- Invoke a specialist against a session, headless in its cwd → Tasks 3 (runner) + 4 (IPC, cwd from session, $HOME guard) + 7 (popover). ✓
- Streaming result view + Copy / Insert-into-session / Save-to-Assets → Task 8 + Task 4 (save writes into cwd/agents so the Assets pane shows it). ✓
- Built-in specialists + custom editor → Task 1 (seed) + Task 2 (migration) + Task 7 (editor). ✓
- Read-first default, write agents flagged → Task 1 (`buildAgentInvocation` deny-tools; `writes`), Task 7 (warning), Task 8. ✓
- No approval hangs / timeout / max-output / no `$HOME` → Task 3 (timeout, cap, kill) + Task 4 (cwd guard). ✓
- Multi-window broadcast (`EVT_AGENTS`/`EVT_AGENT_RUN`) → Task 4. ✓
- Global agents → shelf reads the single agent list (no workspace scoping) → Tasks 5/6. ✓
- Tests: unit (Task 1), migration (Task 2), runner (Task 3), e2e (Task 9). ✓

**Placeholder scan:** No "TBD/handle edge cases." Two spike-dependent spots (exact tool-token names in Task 1/3; a clean-`done` test base in Task 9) carry concrete defaults + explicit fallback instructions, and the tests assert flag presence not exact tokens, so they stay green.

**Type consistency:** `Agent`/`AgentRun` field names, `buildAgentInvocation(base, agent, task, extra)`, `AgentRunner.run(agent, {sessionId,cwd,task,extra})`, and the `window.crew` method names are used identically across Tasks 1→9. `runs` is keyed by run id in both hooks (Task 5) and App (Task 8).

**Phasing note:** This plan is **Phase 1** of the spec (definitions + shelf + headless run + result). Phase 2 (screenshot/transcript context) and Phase 3 (persistent workers / agent-to-agent) are intentionally out of scope.
