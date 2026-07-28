# Custom Crew Terminal (CrewTerm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Crew's ad-hoc xterm.js usage with a Crew-owned terminal subsystem (a `TerminalEngine` interface + an `XtermEngine` adapter + a pure OSC/command-block layer) so Crew owns its terminal API and can extend it, with zero behaviour change for users.

**Architecture:** All `@xterm/*` calls are sealed inside one adapter (`src/renderer/terminal/xterm-engine.ts`) behind a Crew-defined interface (`src/renderer/terminal/engine.ts`). A renderer-side pool (`src/renderer/terminal/pool.ts`) keeps one engine per session (parity with today's `terminal-pool.ts`) and additionally feeds the raw PTY stream through a pure, dependency-free OSC parser (`src/shared/osc.ts`) into a command-block tracker (`src/shared/blocks.ts`). A new React view (`src/renderer/components/CrewTerminal.tsx`) replaces `TerminalView.tsx`. The `main` process (node-pty, detection, transcripts) is untouched.

**Tech Stack:** Electron + electron-vite, React 18 + TypeScript (strict), `@xterm/xterm` 5.5 + `@xterm/addon-fit` (+ new `@xterm/addon-webgl`, `@xterm/addon-unicode11`), Vitest (node env) for pure logic, Playwright for e2e.

## Global Constraints

Every task implicitly includes these. Values copied verbatim from the spec (`docs/superpowers/specs/2026-07-28-custom-terminal-design.md`).

- **Ownership (G1):** No file outside `src/renderer/terminal/xterm-engine.ts` may `import` from `@xterm/*`. Consumers use the Crew interface only.
- **Behaviour parity (G2):** Preserve exactly: scrollback survives tab switches; fit/resize with the bottom-row cap (last row never clipped); focus restoration after DOM re-parent (grid reorder/regroup); prompt landmark (light-yellow row + `#FFCC00` overview-ruler tick) on every submit; clickable asset paths open the Assets panel; OSC-8 hyperlinks open in the external browser; Finder file drag-drop inserts shell-quoted paths + trailing space; tombstone guard prevents resurrecting a disposed terminal; output for a not-yet-viewed session is buffered.
- **Pure shared code:** `src/shared/**` is compiled by BOTH tsconfigs with **no DOM lib** (`lib: ES2022`/`ES2020` only). `src/shared/osc.ts` and `src/shared/blocks.ts` MUST NOT reference DOM or import `@xterm/*` or node-pty.
- **Tests:** Vitest only collects `test/**/*.test.ts` in a **node** environment (`vitest.config.ts`). Put pure unit tests there, importing from `../src/shared/...` (see `test/detection.test.ts` for the exact style).
- **Platform (A3):** macOS **and** Windows must keep working (Windows shipped in 0.3.1). No macOS-only/native code.
- **Parallel-session coordination (CRITICAL):** `.crew-progress.md` states a **parallel session owns `src/renderer/components/TerminalView.tsx` and `src/renderer/terminal-pool.ts`** (the prompt-landmark feature) — "never stage them." Tasks 1–6 create **only new files** and must not edit or stage those two files. Task 7 (the cutover that edits consumers and deletes the old files) has an explicit precondition that the parallel work has merged and the branch is rebased on `main`.
- **Commits:** Commit after each task. **Never `git add -A`** — the repo has uncommitted parallel work (e.g. `src/renderer/grouping.ts`); stage only the exact paths listed in each step.
- **Verify gates:** `npm run typecheck` (node + web), `npm test` (vitest), `npm run build` (electron-vite), `npm run test:e2e` (Playwright against the built app).
- **Addon versions:** `@xterm/addon-webgl@^0.18.0`, `@xterm/addon-unicode11@^0.8.0` (match `@xterm/xterm` 5.5 / `@xterm/addon-fit` ^0.10.0 already present).

---

## File map (decomposition)

| File | Responsibility | Task |
|---|---|---|
| `src/renderer/terminal/engine.ts` | Crew-owned `TerminalEngine` interface + types (the seam). DOM types allowed. | 1 |
| `src/shared/osc.ts` | Pure streaming OSC 133/633/9/7 parser → `OscEvent[]`. No DOM. | 2 |
| `test/osc.test.ts` | Unit tests for `osc.ts`. | 2 |
| `src/shared/blocks.ts` | Pure command-block assembly from `OscEvent`s. No DOM. | 3 |
| `test/blocks.test.ts` | Unit tests for `blocks.ts`. | 3 |
| `src/renderer/terminal/xterm-engine.ts` | `XtermEngine implements TerminalEngine`; the ONLY `@xterm/*` importer (core + fit + webgl + unicode11 + decorations + link providers). | 4 |
| `src/renderer/terminal/pool.ts` | `EnginePool` (one engine/session), tombstones, buffered writes, `markPrompt`, plus OSC→block wiring exposing `getBlocks(id)`. Replaces `terminal-pool.ts` public API. | 5 |
| `src/renderer/components/CrewTerminal.tsx` | React view: mount/re-parent, fit, focus restore, drag-drop, keystroke forwarding. Replaces `TerminalView.tsx`. | 6 |
| consumers + old files | Cutover imports; delete old files; extend e2e. | 7 |

Out of scope for THIS plan (future plans, per spec §8 Phase 2/3): visible block UX (jump-to-prompt, exit-code gutter decorations, fold/copy-output), the `crew-hook` shim, inline images, OSC-9 notifications wiring, engine swap. This plan delivers the owned seam + parity + the pure block foundation that those build on.

---

### Task 1: The `TerminalEngine` interface + addons

**Files:**
- Create: `src/renderer/terminal/engine.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Produces: `TerminalEngine`, `Disposable`, `FitResult`, `RowMark`, `LinkMatch`, `LinkProvider`, `EngineCapabilities` — consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Install the new addons**

Run:
```bash
cd ~/crew && npm install @xterm/addon-webgl@^0.18.0 @xterm/addon-unicode11@^0.8.0
```
Expected: `package.json` `dependencies` now lists `@xterm/addon-webgl` and `@xterm/addon-unicode11`; no build errors. (These are pure-JS; `npm run rebuild:native` is NOT needed — that is only for `node-pty`.)

- [ ] **Step 2: Create the interface file**

Create `src/renderer/terminal/engine.ts`:
```ts
// The Crew-owned terminal boundary. Everything Crew needs from a terminal
// emulator is expressed here; concrete engines (today: XtermEngine) implement
// it. No consumer imports @xterm/* directly — that dependency is sealed inside
// the adapter, so the engine can later be swapped (e.g. a WASM VT core) without
// touching the pool, the React view, or the rest of the app.

export interface Disposable {
  dispose(): void
}

export interface FitResult {
  cols: number
  rows: number
}

/** A full-width row highlight (prompt landmark / block boundary). #RRGGBB only —
 *  xterm decorations reject alpha; kept in the interface for engine-agnosticism. */
export interface RowMark {
  background?: string
  foreground?: string
  /** Overview-ruler tick color (#RRGGBB), shown in the scrollbar gutter. */
  ruler?: string
}

/** A clickable span within one rendered line. Columns are 0-based; `end` is
 *  exclusive (the adapter converts to its own coordinate system). */
export interface LinkMatch {
  start: number
  end: number
  text: string
}

export interface LinkProvider {
  /** Scan one line's plain text and return zero or more matches. */
  provide(lineText: string, y: number): LinkMatch[]
  /** Invoked when the user clicks a match. */
  activate(text: string): void
}

export interface EngineCapabilities {
  webgl: boolean
  images: boolean
}

export interface TerminalEngine {
  // lifecycle / mounting
  mount(host: HTMLElement): void
  /** Detach the DOM element but keep terminal state (scrollback) for tab switches. */
  unmount(host: HTMLElement): void
  dispose(): void
  readonly mounted: boolean

  // io
  write(data: string): void
  onInput(cb: (data: string) => void): Disposable
  resize(cols: number, rows: number): void
  /**
   * Fit the grid to the host. `contentHeightPx` is the mount's TRUE content
   * height (border-box minus padding) so the bottom row is never clipped.
   * Returns the chosen grid size (already applied).
   */
  fit(contentHeightPx: number): FitResult
  focus(): void
  onFocus(cb: () => void): Disposable

  // affordances
  /** Highlight the current cursor row as a landmark; returns a disposer. */
  markRow(mark: RowMark): Disposable
  registerLinkProvider(p: LinkProvider): Disposable
  /** Set the handler for OSC-8 hyperlinks (opened externally, not in-app). */
  setLinkActivator(cb: (uri: string) => void): void

  readonly capabilities: EngineCapabilities
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd ~/crew && npm run typecheck:web
```
Expected: PASS (no errors). The file is types-only, so there is no unit test; `tsc` is the gate.

- [ ] **Step 4: Commit**

```bash
cd ~/crew && git add src/renderer/terminal/engine.ts package.json package-lock.json && git commit -m "feat(terminal): add Crew-owned TerminalEngine interface + webgl/unicode11 addons"
```

---

### Task 2: Pure OSC parser (`src/shared/osc.ts`)

**Files:**
- Create: `src/shared/osc.ts`
- Test: `test/osc.test.ts`

**Interfaces:**
- Produces: `OscEvent` (union), `OscParser` class with `push(chunk: string): OscEvent[]` — consumed by Task 3 (`blocks.ts`) and Task 5 (`pool.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/osc.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { OscParser, type OscEvent } from '../src/shared/osc'

const BEL = '\u0007'
const ESC = '\u001b'

function kinds(events: OscEvent[]): string[] {
  return events.map((e) => e.kind)
}

describe('OscParser — OSC 133 prompt marking', () => {
  it('parses A/B/C/D command lifecycle with exit code', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;A${BEL}$ ${ESC}]133;B${BEL}ls${ESC}]133;C${BEL}out${ESC}]133;D;0${BEL}`)
    expect(kinds(evs)).toEqual(['prompt-start', 'input-start', 'output-start', 'command-end'])
    expect(evs[3].exitCode).toBe(0)
  })

  it('reports a non-zero exit code', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;D;2${BEL}`)
    expect(evs[0].kind).toBe('command-end')
    expect(evs[0].exitCode).toBe(2)
  })

  it('command-end with no code has undefined exitCode', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;D${BEL}`)
    expect(evs[0]).toEqual({ kind: 'command-end', exitCode: undefined })
  })
})

describe('OscParser — split across chunks', () => {
  it('buffers a sequence broken between two pushes', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]133;`)).toEqual([])
    const evs = p.push(`A${BEL}`)
    expect(kinds(evs)).toEqual(['prompt-start'])
  })

  it('handles ST (ESC backslash) terminator', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;C${ESC}\\`)
    expect(kinds(evs)).toEqual(['output-start'])
  })
})

describe('OscParser — 633 / 9 / 7', () => {
  it('parses VS Code OSC 633 command text (E) and end (D)', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]633;E;git status${BEL}${ESC}]633;D;1${BEL}`)
    expect(evs[0]).toEqual({ kind: 'command-text', data: 'git status' })
    expect(evs[1]).toEqual({ kind: 'command-end', exitCode: 1 })
  })

  it('treats OSC 9 text as a notification but ignores OSC 9;4 progress', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]9;Build done${BEL}`)).toEqual([{ kind: 'notify', data: 'Build done' }])
    expect(p.push(`${ESC}]9;4;1;50${BEL}`)).toEqual([])
  })

  it('decodes OSC 7 cwd from a file URI', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]7;file://host/Users/alex/my%20proj${BEL}`)
    expect(evs[0]).toEqual({ kind: 'cwd', cwd: '/Users/alex/my proj' })
  })
})

describe('OscParser — robustness', () => {
  it('ignores plain text and unrelated escape sequences', () => {
    const p = new OscParser()
    expect(p.push(`hello ${ESC}[31mred${ESC}[0m world`)).toEqual([])
  })

  it('does not grow its buffer unbounded on a lone ESC] with no terminator', () => {
    const p = new OscParser()
    p.push(`${ESC}]` + 'x'.repeat(10000))
    // A subsequent complete sequence still parses (buffer was capped, not corrupted).
    const evs = p.push(`${ESC}]133;A${BEL}`)
    expect(kinds(evs)).toContain('prompt-start')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd ~/crew && npx vitest run test/osc.test.ts
```
Expected: FAIL — `Cannot find module '../src/shared/osc'`.

- [ ] **Step 3: Implement `src/shared/osc.ts`**

Create `src/shared/osc.ts`:
```ts
// Pure, dependency-free OSC (Operating System Command) parser. Extracts the
// SEMANTIC marks Crew cares about — OSC 133/633 command lifecycle, OSC 9
// notifications, OSC 7 cwd — from a raw PTY byte stream. Kept free of DOM /
// xterm / node imports (like detection.ts) so it is unit-testable in plain Node
// and reusable in both the renderer (block UI) and main (detection) processes.
//
// OSC framing: ESC ] Ps ; Pt (BEL | ESC \). Sequences can arrive split across
// PTY chunks, so this is a small streaming state machine that retains a partial
// trailing sequence between push() calls.

export type OscKind =
  | 'prompt-start' // 133;A / 633;A  — shell about to draw its prompt
  | 'input-start' //  133;B / 633;B  — prompt end; user input begins
  | 'output-start' // 133;C / 633;C  — command started running
  | 'command-end' //  133;D / 633;D  — command finished (with exit code)
  | 'command-text' // 633;E          — the command line text
  | 'notify' //       9;<text>       — desktop notification
  | 'cwd' //          7;file://…      — working directory report

export interface OscEvent {
  kind: OscKind
  exitCode?: number
  cwd?: string
  data?: string
}

function parseOsc(ps: string, pt: string): OscEvent | null {
  if (ps === '133' || ps === '633') {
    const semi = pt.indexOf(';')
    const sub = semi >= 0 ? pt.slice(0, semi) : pt
    const rest = semi >= 0 ? pt.slice(semi + 1) : ''
    switch (sub) {
      case 'A':
        return { kind: 'prompt-start' }
      case 'B':
        return { kind: 'input-start' }
      case 'C':
        return { kind: 'output-start' }
      case 'D': {
        const code = rest.length ? Number(rest.split(';')[0]) : undefined
        return { kind: 'command-end', exitCode: Number.isFinite(code as number) ? (code as number) : undefined }
      }
      case 'E':
        return { kind: 'command-text', data: rest }
      default:
        return null
    }
  }
  if (ps === '9') {
    // OSC 9;4;… is the progress protocol — not a notification. Ignore in v1.
    if (pt.startsWith('4;')) return null
    return { kind: 'notify', data: pt }
  }
  if (ps === '7') {
    const cwd = fileUriToPath(pt)
    return cwd ? { kind: 'cwd', cwd } : null
  }
  return null
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  const rest = uri.slice('file://'.length)
  const slash = rest.indexOf('/')
  const path = slash >= 0 ? rest.slice(slash) : rest
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export class OscParser {
  private buf = ''
  // Cap the retained partial buffer so a stray, unterminated ESC] can't grow
  // memory without bound. 4096 comfortably fits any real OSC 8/633 payload.
  private static readonly MAX = 4096
  // ESC ] Ps ; Pt (BEL | ESC \). Non-greedy Pt; tolerant of embedded newlines.
  private static readonly SEQ = /\u001b\]([0-9]+);([\s\S]*?)(?:\u0007|\u001b\\)/g

  /** Feed the next PTY chunk; returns any complete semantic marks found. */
  push(chunk: string): OscEvent[] {
    this.buf += chunk
    const events: OscEvent[] = []
    const re = OscParser.SEQ
    re.lastIndex = 0
    let lastEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(this.buf)) !== null) {
      const ev = parseOsc(m[1], m[2])
      if (ev) events.push(ev)
      lastEnd = re.lastIndex
    }
    // Retain only a possibly-incomplete trailing OSC (from the last ESC] at or
    // after the end of the last complete match); discard consumed/plain text.
    const tailStart = this.buf.indexOf('\u001b]', lastEnd)
    this.buf = tailStart >= 0 ? this.buf.slice(tailStart) : ''
    if (this.buf.length > OscParser.MAX) this.buf = this.buf.slice(-OscParser.MAX)
    return events
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd ~/crew && npx vitest run test/osc.test.ts
```
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck (shared is compiled by both configs)**

Run:
```bash
cd ~/crew && npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/crew && git add src/shared/osc.ts test/osc.test.ts && git commit -m "feat(terminal): pure streaming OSC 133/633/9/7 parser with unit tests"
```

---

### Task 3: Pure command-block tracker (`src/shared/blocks.ts`)

**Files:**
- Create: `src/shared/blocks.ts`
- Test: `test/blocks.test.ts`

**Interfaces:**
- Consumes: `OscEvent` from `src/shared/osc.ts`.
- Produces: `Block` (interface), `BlockTracker` class with `apply(e: OscEvent, now: number): void`, `list(): Block[]`, `get size(): number` — consumed by Task 5 (`pool.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/blocks.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { BlockTracker } from '../src/shared/blocks'
import { OscParser } from '../src/shared/osc'

const BEL = '\u0007'
const ESC = '\u001b'

/** Drive a tracker from a raw stream via the real OSC parser. */
function run(stream: string, now = () => 0): BlockTracker {
  const t = new BlockTracker()
  for (const ev of new OscParser().push(stream)) t.apply(ev, now())
  return t
}

describe('BlockTracker', () => {
  it('assembles one completed block from a 133 A/B/C/D cycle', () => {
    const t = run(`${ESC}]133;A${BEL}${ESC}]133;B${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`)
    const blocks = t.list()
    expect(blocks).toHaveLength(1)
    expect(blocks[0].state).toBe('done')
    expect(blocks[0].exitCode).toBe(0)
  })

  it('captures 633 command text and non-zero exit', () => {
    const t = run(`${ESC}]633;A${BEL}${ESC}]633;E;git push${BEL}${ESC}]633;C${BEL}${ESC}]633;D;1${BEL}`)
    const b = t.list()[0]
    expect(b.command).toBe('git push')
    expect(b.exitCode).toBe(1)
    expect(b.state).toBe('done')
  })

  it('records cwd reported mid-block', () => {
    const t = run(`${ESC}]133;A${BEL}${ESC}]7;file://h/tmp${BEL}${ESC}]133;C${BEL}`)
    expect(t.list()[0].cwd).toBe('/tmp')
    expect(t.list()[0].state).toBe('running')
  })

  it('opens a running block when output-start arrives with no prior prompt', () => {
    const t = run(`${ESC}]133;C${BEL}`)
    expect(t.list()).toHaveLength(1)
    expect(t.list()[0].state).toBe('running')
  })

  it('tracks two sequential commands', () => {
    const t = run(
      `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}` +
        `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`
    )
    expect(t.size).toBe(2)
    expect(t.list().every((b) => b.state === 'done')).toBe(true)
  })

  it('does not create a block for a notification', () => {
    const t = run(`${ESC}]9;hello${BEL}`)
    expect(t.size).toBe(0)
  })

  it('stamps startedAt/endedAt from the clock', () => {
    let clock = 100
    const t = new BlockTracker()
    for (const ev of new OscParser().push(`${ESC}]133;A${BEL}`)) t.apply(ev, clock)
    clock = 250
    for (const ev of new OscParser().push(`${ESC}]133;D;0${BEL}`)) t.apply(ev, clock)
    const b = t.list()[0]
    expect(b.startedAt).toBe(100)
    expect(b.endedAt).toBe(250)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd ~/crew && npx vitest run test/blocks.test.ts
```
Expected: FAIL — `Cannot find module '../src/shared/blocks'`.

- [ ] **Step 3: Implement `src/shared/blocks.ts`**

Create `src/shared/blocks.ts`:
```ts
// Pure command-block assembly. Turns the ordered OSC marks from osc.ts into a
// list of "blocks" — one per shell command / agent turn — with exit code, cwd,
// command text, and timing. Dependency-free (no DOM/xterm) so it is unit-tested
// in Node and could also run in main. Row/marker association with the rendered
// grid is intentionally NOT modeled here (that needs the engine's cursor line
// and belongs to a later, DOM-aware phase); this layer is the semantic model.

import type { OscEvent } from './osc'

export type BlockState = 'prompting' | 'running' | 'done'

export interface Block {
  id: number
  command?: string
  cwd?: string
  exitCode?: number
  state: BlockState
  startedAt: number
  endedAt?: number
}

export class BlockTracker {
  private readonly blocks: Block[] = []
  private seq = 0
  private current: Block | null = null

  /** Apply one semantic mark at time `now` (ms). */
  apply(e: OscEvent, now: number): void {
    switch (e.kind) {
      case 'prompt-start':
        this.current = { id: ++this.seq, state: 'prompting', startedAt: now }
        this.blocks.push(this.current)
        break
      case 'input-start':
        if (this.current) this.current.state = 'prompting'
        break
      case 'command-text':
        if (this.current) this.current.command = e.data
        break
      case 'output-start':
        if (!this.current) {
          this.current = { id: ++this.seq, state: 'running', startedAt: now }
          this.blocks.push(this.current)
        } else {
          this.current.state = 'running'
        }
        break
      case 'command-end':
        if (this.current) {
          this.current.state = 'done'
          this.current.exitCode = e.exitCode
          this.current.endedAt = now
        }
        this.current = null
        break
      case 'cwd':
        if (this.current) this.current.cwd = e.cwd
        break
      case 'notify':
        // Not a block boundary; notifications are handled by the caller.
        break
    }
  }

  /** A copy of the block list, oldest first. */
  list(): Block[] {
    return this.blocks.slice()
  }

  get size(): number {
    return this.blocks.length
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd ~/crew && npx vitest run test/blocks.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run:
```bash
cd ~/crew && npm test
```
Expected: PASS — all existing suites plus `osc` and `blocks`.

- [ ] **Step 6: Commit**

```bash
cd ~/crew && git add src/shared/blocks.ts test/blocks.test.ts && git commit -m "feat(terminal): pure command-block tracker from OSC events with unit tests"
```

---

### Task 4: `XtermEngine` adapter (the only `@xterm/*` importer)

**Files:**
- Create: `src/renderer/terminal/xterm-engine.ts`

**Interfaces:**
- Consumes: `TerminalEngine`, `Disposable`, `FitResult`, `RowMark`, `LinkProvider`, `EngineCapabilities` from `./engine`.
- Produces: `class XtermEngine implements TerminalEngine`, `createXtermEngine(): XtermEngine` — consumed by Task 5.

This ports today's `terminal-pool.ts` construction (theme, fonts, scrollback, overview ruler, OSC-8 `linkHandler`) and the row-cap fit logic from `TerminalView.tsx` behind the interface, and adds the WebGL renderer with a safe fallback.

- [ ] **Step 1: Create the adapter**

Create `src/renderer/terminal/xterm-engine.ts`:
```ts
import { Terminal, type IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type {
  Disposable,
  EngineCapabilities,
  FitResult,
  LinkProvider,
  RowMark,
  TerminalEngine
} from './engine'

const THEME = {
  background: '#0A0A0B',
  foreground: '#F2F1EA',
  cursor: '#2B4CF2',
  cursorAccent: '#0A0A0B',
  selectionBackground: 'rgba(43,76,242,0.35)',
  black: '#0A0A0B',
  red: '#e5484d',
  green: '#43b581',
  yellow: '#faa61a',
  blue: '#5F79FF',
  magenta: '#b892ff',
  cyan: '#56cfe1',
  white: '#F2F1EA',
  brightBlack: '#6b6a64'
}

/** xterm's rendered cell height in CSS px (from its render service), or 0 when
 *  not yet measured. Reaches into xterm internals (as FitAddon itself does);
 *  guarded so a shape change just disables the row cap rather than throwing.
 *  Isolated here so no other file depends on xterm internals. */
function cellHeightOf(term: Terminal): number {
  const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
    ._core?._renderService?.dimensions?.css?.cell?.height
  return typeof dims === 'number' && dims > 0 ? dims : 0
}

function toDisposable(d: IDisposable): Disposable {
  return { dispose: () => d.dispose() }
}

export class XtermEngine implements TerminalEngine {
  private readonly term: Terminal
  private readonly fitAddon = new FitAddon()
  private opened = false
  private linkActivator: (uri: string) => void = () => {}
  readonly capabilities: EngineCapabilities = { webgl: false, images: false }

  constructor() {
    this.term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      overviewRulerWidth: 14,
      allowProposedApi: true,
      theme: THEME,
      // OSC 8 hyperlinks: route through Crew's activator (opens externally)
      // instead of letting the default handler spawn an in-app window.
      linkHandler: {
        activate: (_e: MouseEvent, uri: string) => this.linkActivator(uri)
      }
    })
    this.term.loadAddon(this.fitAddon)
    const uni = new Unicode11Addon()
    this.term.loadAddon(uni)
    this.term.unicode.activeVersion = '11'
  }

  mount(host: HTMLElement): void {
    if (!this.opened) {
      this.term.open(host)
      this.opened = true
      // Attach WebGL AFTER open(); fall back silently to canvas/DOM on failure
      // or context loss (browsers can drop the GL context on OOM/suspend).
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        this.term.loadAddon(webgl)
        this.capabilities.webgl = true
      } catch {
        this.capabilities.webgl = false
      }
    } else if (this.term.element) {
      host.appendChild(this.term.element)
    }
  }

  unmount(host: HTMLElement): void {
    const el = this.term.element
    if (el && el.parentElement === host) host.removeChild(el)
  }

  dispose(): void {
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }

  get mounted(): boolean {
    return this.opened && !!this.term.element?.isConnected
  }

  write(data: string): void {
    this.term.write(data)
  }

  onInput(cb: (data: string) => void): Disposable {
    return toDisposable(this.term.onData(cb))
  }

  onFocus(cb: () => void): Disposable {
    // xterm exposes textarea focus; bind directly so callers can restore focus
    // after a DOM re-parent blurs the hidden textarea.
    const ta = this.term.textarea
    if (!ta) return { dispose: () => {} }
    ta.addEventListener('focus', cb)
    return { dispose: () => ta.removeEventListener('focus', cb) }
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  fit(contentHeightPx: number): FitResult {
    this.fitAddon.fit()
    // FitAddon measures padding on the .xterm element, but Crew's padding lives
    // on the parent mount (border-box), so it proposes one row too many and the
    // bottom row (input prompt / footer) gets clipped. Cap rows to the mount's
    // true content height so the last row is always fully visible.
    const cellH = cellHeightOf(this.term)
    if (cellH > 0 && contentHeightPx > 0) {
      const maxRows = Math.max(1, Math.floor(contentHeightPx / cellH))
      if (this.term.rows > maxRows) this.term.resize(this.term.cols, maxRows)
    }
    return { cols: this.term.cols, rows: this.term.rows }
  }

  focus(): void {
    this.term.focus()
  }

  markRow(mark: RowMark): Disposable {
    const marker = this.term.registerMarker(0)
    if (!marker) return { dispose: () => {} }
    const dec = this.term.registerDecoration({
      marker,
      x: 0,
      width: this.term.cols,
      backgroundColor: mark.background,
      foregroundColor: mark.foreground,
      layer: 'bottom',
      overviewRulerOptions: mark.ruler ? { color: mark.ruler, position: 'full' } : undefined
    })
    return { dispose: () => dec?.dispose() }
  }

  registerLinkProvider(p: LinkProvider): Disposable {
    const sub = this.term.registerLinkProvider({
      provideLinks: (y, cb) => {
        const line = this.term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        const links = p.provide(text, y).map((m) => ({
          // xterm ranges are 1-based with an inclusive end column.
          range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
          text: m.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (_e: MouseEvent, t: string) => p.activate(t)
        }))
        cb(links.length ? links : undefined)
      }
    })
    return toDisposable(sub)
  }

  setLinkActivator(cb: (uri: string) => void): void {
    this.linkActivator = cb
  }
}

export function createXtermEngine(): XtermEngine {
  return new XtermEngine()
}
```

- [ ] **Step 2: Typecheck (renderer)**

Run:
```bash
cd ~/crew && npm run typecheck:web
```
Expected: PASS. If `allowProposedApi` or `unicode.activeVersion` type errors appear, they are valid xterm 5.5 APIs — ensure `@xterm/addon-unicode11` is installed (Task 1).

- [ ] **Step 3: Build (bundles the renderer + addons)**

Run:
```bash
cd ~/crew && npm run build
```
Expected: `electron-vite` build succeeds (main + preload + renderer). This confirms the new addon imports resolve.

- [ ] **Step 4: Commit**

```bash
cd ~/crew && git add src/renderer/terminal/xterm-engine.ts && git commit -m "feat(terminal): XtermEngine adapter (sole @xterm importer; webgl + unicode11 + row-cap fit)"
```

---

### Task 5: `EnginePool` with OSC→block wiring (`src/renderer/terminal/pool.ts`)

**Files:**
- Create: `src/renderer/terminal/pool.ts`

**Interfaces:**
- Consumes: `createXtermEngine` from `./xterm-engine`; `TerminalEngine`, `Disposable`, `LinkProvider` from `./engine`; `OscParser` from `../../shared/osc`; `BlockTracker`, `Block` from `../../shared/blocks`; `findAssetPaths` from `../../shared/assets`; `previewToken` from `../preview-bus`.
- Produces (replacing the current `terminal-pool.ts` surface): `getPooled(id): Pooled`, `writeTo(id, data)`, `focusTerminal(id)`, `markPrompt(id)`, `disposePooled(id)`, and NEW `getBlocks(id): Block[]`. Consumed by Task 6 (`CrewTerminal.tsx`) and Task 7 consumers.

- [ ] **Step 1: Create the pool**

Create `src/renderer/terminal/pool.ts`:
```ts
// A renderer-side pool of terminal engines — one per session, kept alive for the
// whole session lifetime so scrollback and PTY state survive tab switches. The
// visible <CrewTerminal> imperatively (re)attaches the engine's DOM element;
// output is written here regardless of whether the session is currently shown.
//
// Beyond rendering, the pool feeds the same PTY stream through the pure OSC
// parser + block tracker (shared/), so every session accrues a semantic command
// history (getBlocks) that future UI can navigate — the payoff of owning the
// terminal layer. Parsing here (not in the engine) keeps blocks engine-agnostic.

import { createXtermEngine } from './xterm-engine'
import type { Disposable, LinkProvider, TerminalEngine } from './engine'
import { OscParser } from '../../shared/osc'
import { BlockTracker, type Block } from '../../shared/blocks'
import { findAssetPaths } from '../../shared/assets'
import { previewToken } from '../preview-bus'

export interface Pooled {
  engine: TerminalEngine
  parser: OscParser
  blocks: BlockTracker
  linkSub: Disposable
}

const pool = new Map<string, Pooled>()
// Ids of sessions whose engines have been disposed. A killed PTY can emit one
// last chunk *after* the session left the roster; without this guard writeTo →
// getPooled would recreate ("resurrect") a terminal that is never attached or
// disposed again. Session ids are UUIDs (never reused), so this set is safe.
const tombstones = new Set<string>()

// Prompt-landmark colors: each time you submit input, markPrompt() tints that
// row light-yellow with black text (a decoration overlay — it never injects
// bytes into the PTY stream) and drops a yellow tick in the overview ruler.
const PROMPT_BG = '#FFF9C4'
const PROMPT_FG = '#000000'
const PROMPT_RULER = '#FFCC00'

export function getPooled(id: string): Pooled {
  let p = pool.get(id)
  if (!p) {
    const engine = createXtermEngine()
    engine.setLinkActivator((uri) => void window.crew.openExternal(uri))
    // Make previewable file paths in output clickable — clicking resolves the
    // token against the session cwd and opens it in the Assets panel.
    const provider: LinkProvider = {
      provide: (lineText, _y) =>
        findAssetPaths(lineText).map((m) => ({ start: m.start, end: m.end, text: m.text })),
      activate: (text) => void previewToken(id, text)
    }
    const linkSub = engine.registerLinkProvider(provider)
    p = { engine, parser: new OscParser(), blocks: new BlockTracker(), linkSub }
    pool.set(id, p)
  }
  return p
}

export function writeTo(id: string, data: string): void {
  if (tombstones.has(id)) return
  // Create-on-demand so output for a not-yet-viewed session is buffered in the
  // engine (preserving scrollback) rather than dropped.
  const p = getPooled(id)
  p.engine.write(data)
  const now = Date.now()
  for (const ev of p.parser.push(data)) p.blocks.apply(ev, now)
}

/** Focus a session's terminal (e.g. after inserting a skill invocation). */
export function focusTerminal(id: string): void {
  pool.get(id)?.engine.focus()
}

/** Semantic command blocks accrued for a session (oldest first). */
export function getBlocks(id: string): Block[] {
  return pool.get(id)?.blocks.list() ?? []
}

/**
 * Highlight the row where the user just submitted input, as a scannable
 * landmark. Called on every submit (see CrewTerminal's onInput). Recolors the
 * cursor row (light-yellow bg + black text) and adds an overview-ruler tick,
 * without writing anything to the PTY — so the agent's own TUI is untouched.
 */
export function markPrompt(id: string): void {
  const p = pool.get(id)
  if (!p || !p.engine.mounted) return
  p.engine.markRow({ background: PROMPT_BG, foreground: PROMPT_FG, ruler: PROMPT_RULER })
}

export function disposePooled(id: string): void {
  const p = pool.get(id)
  if (p) {
    try {
      p.linkSub.dispose()
      p.engine.dispose()
    } catch {
      /* already disposed */
    }
    pool.delete(id)
  }
  tombstones.add(id)
}
```

- [ ] **Step 2: Typecheck + build**

Run:
```bash
cd ~/crew && npm run typecheck:web && npm run build
```
Expected: PASS. (`window.crew` is typed via the existing preload contract; `findAssetPaths`/`previewToken` signatures match today's `terminal-pool.ts` usage.)

- [ ] **Step 3: Commit**

```bash
cd ~/crew && git add src/renderer/terminal/pool.ts && git commit -m "feat(terminal): EnginePool with parity lifecycle + OSC->block wiring (getBlocks)"
```

---

### Task 6: `CrewTerminal.tsx` React view

**Files:**
- Create: `src/renderer/components/CrewTerminal.tsx`

**Interfaces:**
- Consumes: `getPooled`, `focusTerminal`, `markPrompt` from `../terminal/pool`; `quotePaths` from `../../shared/shell-quote`.
- Produces: `export function CrewTerminal({ id, focusOnMount }): JSX.Element` — consumed by Task 7.

This ports `TerminalView.tsx` (mount/re-parent, fit with ResizeObserver + font-ready re-fit, focus restoration across re-parents, Finder drag-drop) to the engine interface. The `window.crew.resize` IPC and drag-drop behaviour are unchanged.

- [ ] **Step 1: Create the view**

Create `src/renderer/components/CrewTerminal.tsx`:
```tsx
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPooled, focusTerminal, markPrompt } from '../terminal/pool'
import { quotePaths } from '../../shared/shell-quote'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

// The session whose terminal was last focused. Tracked at module scope so we can
// restore focus after a DOM re-parent (grid reorder / regrouping / view swap)
// silently blurs xterm's hidden textarea — which otherwise leaves the terminal
// unable to accept input until the user toggles views. `focusBound` ensures we
// attach the focus listener to each pooled engine only once.
let lastFocusedTerminal: string | null = null
const focusBound = new Set<string>()

/**
 * Mounts a pooled terminal engine into the visible pane. The engine itself lives
 * in the pool for the session's whole lifetime; here we just (re)attach its DOM
 * element, keep it fitted to the container, and forward keystrokes to the PTY.
 *
 * Files dropped from Finder are inserted as shell-quoted paths at the agent's
 * prompt (e.g. drop a screenshot into Claude Code).
 */
export function CrewTerminal({
  id,
  focusOnMount = true
}: {
  id: string
  focusOnMount?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // dragenter/leave fire for every child; a depth counter avoids flicker.
  const depth = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = getPooled(id)
    p.engine.mount(host)

    // Remember this terminal as the focus target whenever it gains focus, so a
    // later DOM re-parent that blurs it can hand focus back (see layout effect).
    if (!focusBound.has(id)) {
      p.engine.onFocus(() => {
        lastFocusedTerminal = id
      })
      focusBound.add(id)
    }

    let disposed = false
    const fit = (): void => {
      if (disposed) return
      const host = hostRef.current
      if (!host) return
      try {
        const cs = getComputedStyle(host)
        const contentH =
          host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')
        const { cols, rows } = p.engine.fit(contentH)
        window.crew.resize(id, cols, rows)
      } catch {
        /* container not measurable yet */
      }
    }

    // Fit after layout settles.
    const raf = requestAnimationFrame(fit)
    // JetBrains Mono loads asynchronously; the engine measures cell height at
    // open() time, so re-fit once fonts are ready or the bottom row clips.
    void document.fonts?.ready.then(fit)
    if (focusOnMount || lastFocusedTerminal === id) p.engine.focus()

    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    // Forward keystrokes to the PTY. A carriage return means the user submitted
    // input, so drop a landmark on that row (see markPrompt).
    const inputSub = p.engine.onInput((d) => {
      window.crew.sendInput(id, d)
      if (d.includes('\r') || d.includes('\n')) markPrompt(id)
    })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputSub.dispose()
      // Detach (but do NOT dispose) so scrollback survives tab switches.
      p.engine.unmount(host)
    }
  }, [id, focusOnMount])

  // Reordering tiles within a group re-parents the terminal's DOM node via React
  // reconciliation (no remount) which blurs xterm's textarea. Runs on every
  // render: if this was the focused terminal and focus fell to <body>, reclaim
  // it — so input keeps working without having to toggle views.
  useLayoutEffect(() => {
    if (lastFocusedTerminal !== id) return
    const p = getPooled(id)
    if (p.engine.mounted && document.activeElement === document.body) {
      p.engine.focus()
    }
  })

  function onDragEnter(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current++
    setDragOver(true)
  }
  function onDragOver(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragOver(false)
  }
  function onDrop(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.crew.pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    // Trailing space so the user (or agent) can keep typing right after.
    window.crew.sendInput(id, quotePaths(paths) + ' ')
    focusTerminal(id)
  }

  return (
    <div
      className="term-drop"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="term-mount" ref={hostRef} />
      {dragOver && (
        <div className="term-drop__overlay">
          <span className="term-drop__hint">Drop to insert file path</span>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck + build**

Run:
```bash
cd ~/crew && npm run typecheck:web && npm run build
```
Expected: PASS. (CSS classes `term-drop`, `term-mount`, `term-drop__overlay`, `term-drop__hint` already exist in `styles.css`.)

- [ ] **Step 3: Commit**

```bash
cd ~/crew && git add src/renderer/components/CrewTerminal.tsx && git commit -m "feat(terminal): CrewTerminal React view over the engine interface (parity with TerminalView)"
```

---

### Task 7: Cutover — switch consumers, extend e2e, delete old files

> **PRECONDITION (hard gate):** The parallel session that owns
> `src/renderer/components/TerminalView.tsx` and `src/renderer/terminal-pool.ts`
> (prompt-landmark feature, per `.crew-progress.md`) has merged to `main`.
> Rebase this branch on `main` first: `git fetch origin && git rebase origin/main`.
> Only then edit/delete those files. If it has NOT merged, STOP and do only
> Tasks 1–6; leave this task for later.

**Files:**
- Modify: `src/renderer/components/SessionView.tsx` (imports + usage)
- Modify: `src/renderer/components/GridView.tsx` (imports + usage — verify with grep)
- Modify: `src/renderer/App.tsx` (import of `focusTerminal`)
- Modify: `src/renderer/components/AssetsPanel.tsx` (import of `focusTerminal`)
- Modify: `src/renderer/components/SkillsBar.tsx` (import of `focusTerminal`)
- Modify: `test/e2e/crew.e2e.mjs` (no source change needed if it drives the DOM terminal generically; add block assertion if it references terminal internals)
- Delete: `src/renderer/components/TerminalView.tsx`
- Delete: `src/renderer/terminal-pool.ts`

**Interfaces:**
- Consumes: `CrewTerminal` from `../terminal/pool` view (Task 6) and `focusTerminal`/`getBlocks` from `../terminal/pool` (Task 5).

- [ ] **Step 1: Find every consumer of the old modules**

Run:
```bash
cd ~/crew && grep -rn "terminal-pool\|TerminalView" src --include=*.ts --include=*.tsx
```
Expected: a list including `SessionView.tsx` (imports `TerminalView` + `focusTerminal`), `GridView.tsx`, `App.tsx`, `AssetsPanel.tsx`, `SkillsBar.tsx`. Note each path/line; these are the exact edit sites.

- [ ] **Step 2: Repoint `focusTerminal` imports**

In `src/renderer/App.tsx`, `src/renderer/components/AssetsPanel.tsx`, and `src/renderer/components/SkillsBar.tsx`, change:
```ts
import { focusTerminal } from '../terminal-pool'
```
to:
```ts
import { focusTerminal } from '../terminal/pool'
```
(In `App.tsx` the relative path is `'./terminal/pool'` if `App.tsx` sits in `src/renderer/`; match the existing prefix — only the `terminal-pool` → `terminal/pool` segment changes.)

- [ ] **Step 3: Swap the terminal component in `SessionView.tsx`**

In `src/renderer/components/SessionView.tsx`, change the import:
```tsx
import { TerminalView } from './TerminalView'
```
to:
```tsx
import { CrewTerminal } from './CrewTerminal'
```
and its usage:
```tsx
<TerminalView id={session.id} key={session.id} />
```
to:
```tsx
<CrewTerminal id={session.id} key={session.id} />
```
Also update its `focusTerminal` import (top of file) from `'../terminal-pool'` to `'../terminal/pool'`.

- [ ] **Step 4: Swap the terminal component in `GridView.tsx` (if present)**

Using the grep results from Step 1, apply the same two changes in `src/renderer/components/GridView.tsx` if it renders `TerminalView`:
```tsx
// import
import { CrewTerminal } from './CrewTerminal'
// usage (preserve existing props such as focusOnMount / key)
<CrewTerminal id={/* existing id expr */} focusOnMount={/* existing */} key={/* existing */} />
```
If `GridView.tsx` does not reference `TerminalView`, skip this step.

- [ ] **Step 5: Verify no references to the old modules remain**

Run:
```bash
cd ~/crew && grep -rn "terminal-pool\|TerminalView" src --include=*.ts --include=*.tsx
```
Expected: **no matches** (empty output).

- [ ] **Step 6: Delete the old files**

Run:
```bash
cd ~/crew && git rm src/renderer/components/TerminalView.tsx src/renderer/terminal-pool.ts
```
Expected: both files staged for deletion.

- [ ] **Step 7: Typecheck + build**

Run:
```bash
cd ~/crew && npm run typecheck && npm run build
```
Expected: PASS for main, preload, and web. No unresolved imports.

- [ ] **Step 8: Extend the e2e to assert the new terminal + zero errors**

Open `test/e2e/crew.e2e.mjs`. It launches the built app and drives the terminal (create session, type, rename, restart, close) asserting zero renderer/main errors. Confirm its terminal interactions target the DOM (`.term-mount`, xterm textarea) rather than a `TerminalView`-specific selector. If it references a `TerminalView` class/testid, repoint it to the `.term-mount` container. Add one assertion that typing then Enter still works (landmark path):
```js
// after typing a command and pressing Enter in the focused terminal:
await page.keyboard.type('echo hi')
await page.keyboard.press('Enter')
// the terminal mount is still present and the app logged no errors (asserted at teardown)
await page.waitForSelector('.term-mount')
```

- [ ] **Step 9: Run the full verification suite**

Run:
```bash
cd ~/crew && npm run typecheck && npm test && npm run test:e2e
```
Expected: typecheck PASS; vitest PASS (incl. `osc`, `blocks`); e2e PASS with **zero** renderer/main-process errors.

- [ ] **Step 10: Manual parity smoke test (G2 checklist)**

Run `npm run dev`, then verify by hand: (a) create a Shell session, type, see echo; (b) submit a line → light-yellow landmark row + yellow tick in the scrollbar; (c) print a file path in output → it is clickable and opens the Assets panel; (d) an `\e]8;;https://example.com\e\\link\e]8;;\e\\` hyperlink opens the external browser; (e) drag a Finder file onto the terminal → shell-quoted path inserted with trailing space; (f) switch tabs/among grid tiles → scrollback preserved and focus retained; (g) resize the window → bottom row never clipped.

- [ ] **Step 11: Commit**

```bash
cd ~/crew && git add src/renderer/App.tsx src/renderer/components/SessionView.tsx src/renderer/components/GridView.tsx src/renderer/components/AssetsPanel.tsx src/renderer/components/SkillsBar.tsx test/e2e/crew.e2e.mjs && git commit -m "refactor(terminal): cut over to CrewTerminal/EnginePool; remove xterm-coupled TerminalView + terminal-pool"
```
(Stage only the exact paths above; `git rm` from Step 6 already staged the deletions. Never `git add -A` — other uncommitted parallel work may be present.)

---

## Self-review (author checklist — completed)

- **Spec coverage:** §6.1 file layout → Tasks 1–6; §6.2 interface → Task 1; §6.3 adapter (webgl fallback, unicode11, row-cap, OSC-8, theme, links) → Task 4; §6.4 OSC parser + block model → Tasks 2–3, wired in Task 5; §3.2 dependency inventory (fit, focus, markRow, links, tombstones, buffered writes) → Tasks 4–6; §8 Phase 0+1 → this plan; §9 testing (pure unit tests in `test/`, e2e) → Tasks 2/3/7; §10 parallel-session risk → Global Constraints + Task 7 precondition. Phase 2/3 items (jump-to-prompt, decorations, crew-hook, images, notifications) are explicitly out of scope (documented above) — deferred to follow-up plans per spec §8.
- **Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N"; every code step contains complete code; every command has an expected result.
- **Type consistency:** `TerminalEngine`/`Disposable`/`FitResult`/`RowMark`/`LinkProvider`/`EngineCapabilities` defined in Task 1 are used verbatim in Tasks 4–6; `OscEvent`/`OscParser.push` (Task 2) are consumed by Task 3 and Task 5; `BlockTracker.apply/list/size` + `Block` (Task 3) are consumed by Task 5's `getBlocks`; pool surface (`getPooled/writeTo/focusTerminal/markPrompt/disposePooled/getBlocks`) matches the old `terminal-pool.ts` names (plus `getBlocks`) so consumers in Task 7 only change the import path.

---

## Execution handoff

Recommended: **subagent-driven** (fresh subagent per task, review between tasks). Tasks 1–6 are independent of the parallel session and can proceed immediately; **Task 7 is gated** on the prompt-landmark parallel session merging to `main`.
