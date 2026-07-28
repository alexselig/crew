# Design: A Custom, Crew-Owned Terminal Layer ("CrewTerm")

- **Date:** 2026-07-28
- **Status:** Draft for review
- **Author:** Alex Selig (with Copilot)
- **Scope:** Replace Crew's ad-hoc xterm.js usage with a Crew-owned terminal
  subsystem that Crew controls end-to-end and can extend for agent-specific UX.

> **Autopilot note:** This spec was produced without live Q&A (author was away).
> It states its assumptions explicitly (see §2) and leads with a recommended
> approach while documenting the alternatives that were considered so the author
> can redirect on review.

---

## 1. Motivation

Crew embeds one terminal per AI session. Today that terminal is xterm.js used
directly in two files (`src/renderer/terminal-pool.ts` and
`src/renderer/components/TerminalView.tsx`). Every Crew-specific behaviour —
prompt landmarks, clickable asset paths, OSC-8 link handling, the row-cap fit
hack that reaches into xterm internals — is written *against xterm's API and
internals*. Growing the terminal's UX (command blocks, jump-to-prompt,
exit-code decorations, inline images, agent-aware affordances) means fighting
xterm's abstractions and reaching deeper into private fields (we already touch
`term._core._renderService.dimensions`).

The goal is to **own the terminal layer**: a first-class Crew subsystem with its
own API, so we can build agent-aware terminal UX freely, and — as a bonus — swap
the underlying VT engine later without touching the rest of Crew.

### What this is *not*

Per `SPEC.md` §4 ("Not a general terminal replacement / not trying to beat
iTerm2 on features") and §15 ("Lean on mature node-pty + xterm.js"), we are **not
writing a VT100/xterm emulator from scratch**. Correct VT emulation is thousands
of edge cases (wide/combining chars, reflow, alt-screen, scroll regions, DEC
modes, bracketed paste, mouse protocols) that xterm.js and VS Code have spent
years hardening. Reinventing that is high-risk and off-mission. "Custom" here
means **Crew owns the terminal *implementation and API*, with the VT engine as a
swappable dependency behind it** — not that Crew re-implements ANSI parsing on
day one.

---

## 2. Goals, non-goals, and assumptions

### Goals

- **G1 — Ownership:** All terminal behaviour lives behind a Crew-defined
  interface (`TerminalEngine`) and Crew-owned components, not scattered xterm
  calls. No consumer imports `@xterm/*` directly.
- **G2 — Behaviour parity:** Everything the current terminal does keeps working:
  scrollback survives tab switches, fit/resize (including the bottom-row cap),
  focus restoration across DOM re-parents, prompt landmarks + overview-ruler
  ticks, clickable asset paths, OSC-8 links open externally, Finder file
  drag-drop inserts shell-quoted paths, theme.
- **G3 — Extensibility for agents:** Ship at least one genuinely new,
  ownership-enabled capability — **semantic command blocks** (OSC 133/633) with
  jump-to-prompt and exit-code decorations — to prove the seam pays off.
- **G4 — Swappable engine:** The interface is designed so a future
  `GhosttyWasmEngine` (libghostty-vt) or WebGPU engine can drop in without
  changing block logic, the React view, or `main`.
- **G5 — No perf regression:** Match or beat today by enabling
  `@xterm/addon-webgl` (GPU renderer) behind the adapter.

### Non-goals

- Native NSView embedding / GPU-native rendering **now** (documented as future,
  §11).
- Session *persistence*/multiplexing (tmux/Zellij). Valuable but a separate
  concern from the terminal component; noted in §11.
- Changing the `main`-process PTY ownership, detection engine, transcripts, or
  cost parsing. Those stay exactly as they are.

### Assumptions (state, then proceed)

- **A1 (primary driver):** The driver is **control & extensibility** first,
  rendering quality second. Rationale: the changelog shows terminal *refinements*
  (browser links, arrow-key prompt editing, prompt landmarks) but no performance
  complaints; the SPEC's own design leans on xterm as a mature core; and the
  explicit ask was "custom … so I can improve it for crew app purposes."
- **A2:** Electron/React/TypeScript stack stays. No Rust/Zig toolchain is
  introduced in the committed scope.
- **A3:** macOS + Windows must both keep working (Windows support shipped in
  0.3.1), so no macOS-only native path in committed scope.

If A1 is wrong and the real driver is *native GPU rendering quality*, jump to
§11 Path C — the interface from this spec is still the right first step.

---

## 3. How the terminal works today (current state)

### 3.1 Data flow

```
 main process (Node)                         renderer (React)
 ─────────────────────                       ─────────────────
 node-pty  ──proc.onData──▶ SessionManager
                             ├─ emit 'output' ──IPC EVT_OUTPUT──▶ onOutput(cb)
                             │                                     └─ writeTo(id,data)
                             │                                        └─ xterm term.write(data)
                             ├─ detector.pushOutput(data)   (state)
                             ├─ transcript.append(stripAnsi)
                             └─ cost/credits.push(stripAnsi)

 xterm term.onData(d) ──window.crew.sendInput──IPC SESSION_INPUT──▶ SessionManager.input
                                                                     ├─ proc.write(d)
                                                                     └─ detector.notifyInput
 FitAddon → cols/rows ─────window.crew.resize──IPC SESSION_RESIZE──▶ proc.resize(cols,rows)
```

Key property: the terminal emulator is a **pure renderer + input source +
affordance layer**. All the "brain" (state detection, transcripts, cost) runs in
`main` on the raw byte stream and is *independent of the renderer*. A terminal
replacement therefore only touches the renderer's two files (plus CSS).

### 3.2 xterm.js API surface Crew depends on (inventory)

From `terminal-pool.ts` and `TerminalView.tsx`:

| Capability | xterm API used |
|---|---|
| Construct | `new Terminal({fontFamily,fontSize,lineHeight,cursorBlink,scrollback,overviewRulerWidth,theme,linkHandler})` |
| Mount / re-parent | `term.open(host)`, `term.element`, `term.textarea` |
| Write output | `term.write(data)` |
| Input | `term.onData(cb)` |
| Sizing | `FitAddon.fit()`, `term.resize()`, `term.cols/rows` |
| Focus | `term.focus()`, focus event on `textarea` |
| Prompt landmark | `term.registerMarker(0)` + `term.registerDecoration({backgroundColor,foregroundColor,overviewRulerOptions,…})` |
| Asset links | `term.registerLinkProvider(...)`, `term.buffer.active.getLine(y).translateToString()` |
| OSC-8 links | `linkHandler.activate` |
| Teardown | `term.dispose()` |
| Row-cap hack | reads `term._core._renderService.dimensions.css.cell.height` (private) |

The pool also keeps a **tombstone set** so a killed PTY's final chunk can't
resurrect a disposed terminal, and buffers output for not-yet-viewed sessions.
These lifecycle semantics must be preserved.

### 3.3 The latent opportunity in the SPEC

`SPEC.md` §5 already describes an unbuilt **`crew-hook`** shim: agents/shells
source it to emit OSC 133 command-start/end (and OSC 9) marks, giving *exact*
state instead of heuristics. Owning the terminal makes this — and the command
"blocks" UX it enables — first-class. This is the flagship "improve it for crew
purposes" feature.

---

## 4. Design principle: own the seam, not the VT engine

Introduce a thin **Crew-owned boundary** (`TerminalEngine`) that captures exactly
the capabilities in §3.2 as a Crew API. Back it initially with an
`XtermEngine` adapter (xterm.js + addons). Build every Crew feature — blocks,
decorations, links, drag-drop, fit — against the *Crew interface*, never against
xterm directly. The engine becomes a replaceable dependency; the value (the
semantic/UX layer) is Crew's own code.

This is the pragmatic center of the design: it delivers a genuinely custom,
improvable terminal *today* at low risk, and unlocks a native/WASM engine swap
*later* for free.

---

## 5. Approaches considered

Condensed from the terminal-landscape research (full citations in §12). Each was
evaluated against: ownership/extensibility, risk, effort, cross-platform,
rendering quality.

| # | Approach | Ownership | Effort | Risk | Quality ceiling | Verdict |
|---|---|---|---|---|---|---|
| **A** | **Crew-owned interface + xterm adapter + semantic block layer** (this spec) | High (Crew owns API + all UX) | Low–Med | Low | Med (xterm-WebGL) | ✅ **Recommended** |
| B | Fork/vendor xterm.js and modify internals | High | Med | Med (maintenance drift) | Med | ❌ Maintenance burden, no need |
| C | Custom VT emulator from scratch (TS) | Total | Very High | High | Med | ❌ Off-mission, reinvents years of edge cases |
| D | libghostty-vt (WASM) parser + custom/xterm renderer | High | High | Med (API alpha) | High | ⏳ Future engine swap (§11) |
| E | Native NSView + libghostty (Metal) via FFI | High | High | Med–High | Highest | ⏳ Future, macOS-only (§11) |
| F | Rio `sugarloaf` WASM + WebGPU renderer | High | High | High (WebGPU-in-Electron experimental) | High | ⏳ Future (§11) |
| G | tmux/Zellij sidecar for session persistence | n/a (session mgmt) | Med | Low | n/a | ⏳ Separate concern (§11) |

**Why A wins now:** research confirms (a) xterm.js + `addon-webgl` is the fastest
pure-JS renderer (~8,000+ FPS) and *actively maintained* (co-maintained with the
VS Code terminal team, not deprecated); (b) Crew's likely throughput bottleneck
is the **IPC path**, not the renderer; (c) `libghostty-vt`'s embeddable C/WASM
API is still **public alpha with no stable tag**; (d) WebGPU in Electron is
experimental. So the high-quality native/WASM engines are real but premature —
and approach A is exactly the interface that lets us adopt them later without a
rewrite. VS Code itself is the proof of this pattern: xterm.js + node-pty + a
large **shell-integration/OSC-633 layer of their own** on top.

---

## 6. Recommended architecture — "CrewTerm"

### 6.1 New file layout (renderer)

```
src/renderer/terminal/
  engine.ts          # TerminalEngine interface + shared types (the SEAM, Crew-owned)
  xterm-engine.ts    # XtermEngine: adapter backing the interface with xterm.js + addons
  pool.ts            # EnginePool keyed by session id (replaces terminal-pool.ts)
  blocks.ts          # semantic command-block model built from OSC marks
  decorations.ts     # prompt landmarks, exit-code gutter marks, overview-ruler ticks
  links.ts           # asset-path + OSC-8 link providers (moved off xterm-specific code)
src/renderer/components/
  CrewTerminal.tsx   # React view (replaces TerminalView.tsx): mount, fit, focus, drag-drop, block nav
src/shared/
  osc.ts             # dependency-free OSC 133/633/9 parser (+ unit tests), sibling to detection.ts
src/main/crew-hook/
  crew-hook.sh       # optional shell shim emitting OSC 133/9 marks (SPEC §5); injected via env
```

Only `CrewTerminal.tsx` and `pool.ts` are imported by the rest of the app
(`SessionView`, `App`, `AssetsPanel`, `SkillsBar` call `focusTerminal`/mount).
Everything `@xterm/*` is sealed inside `xterm-engine.ts`.

### 6.2 The `TerminalEngine` interface (the seam)

A minimal, engine-agnostic contract — the union of §3.2 plus the block hooks.
Illustrative shape (final types land in `engine.ts`):

```ts
export interface TerminalEngine {
  // lifecycle / mounting
  mount(host: HTMLElement): void
  unmount(host: HTMLElement): void        // detach DOM, keep state (tab switch)
  dispose(): void
  readonly mounted: boolean

  // io
  write(data: string): void               // PTY -> screen
  onInput(cb: (data: string) => void): Disposable   // keystrokes -> PTY
  resize(cols: number, rows: number): void
  fit(hostContentHeightPx: number): { cols: number; rows: number }
  focus(): void
  onFocus(cb: () => void): Disposable

  // affordances (capability-gated; a minimal engine may no-op)
  markRow(opts: RowMark): Disposable      // prompt landmark / block boundary
  addDecoration(range: CellRange, style: DecorStyle): Disposable
  registerLinkProvider(p: LinkProvider): Disposable
  readLine(y: number): string             // buffer text for link scanning
  setLinkActivator(cb: (uri: string) => void): void  // OSC-8

  // introspection for the block layer
  onOsc(cb: (seq: OscEvent) => void): Disposable   // 133/633/9 semantic marks
  readonly capabilities: EngineCapabilities        // {images, kittyKeyboard, webgl, …}
}
```

`fit()` takes the mount's true content height so the **bottom-row cap** (today's
internal-reading hack) becomes an explicit, engine-owned calculation rather than
a reach into private xterm fields.

### 6.3 `XtermEngine` adapter

Implements `TerminalEngine` with:

- `@xterm/xterm` core + `@xterm/addon-fit`
- **`@xterm/addon-webgl`** for GPU rendering (G5), with a Canvas/DOM fallback on
  `webglcontextlost` (research flagged context-loss; handle by disposing and
  re-adding the addon)
- `@xterm/addon-unicode11` (+ graphemes) for correct width handling
- `@xterm/addon-image` (Sixel / iTerm2 OSC 1337) — gated behind
  `capabilities.images` and a setting (Phase 3)
- `@xterm/addon-ligatures` — Electron/Node context only (Phase 3, opt-in)

All current visuals (theme, prompt landmark colors, overview-ruler ticks,
asset-path + OSC-8 links) are re-expressed through the adapter. The tombstone /
create-on-demand / buffer-when-hidden semantics move into `pool.ts` unchanged.

### 6.4 Semantic command blocks (`shared/osc.ts` + `blocks.ts`)

`shared/osc.ts` is a **pure, dependency-free** parser (mirroring
`detection.ts`'s design and testability) that scans the byte stream for:

- **OSC 133** `A`/`B`/`C`/`D;exit` — prompt start / input start / output start /
  command end + exit code (FinalTerm/FTCS; supported by Ghostty, WezTerm, kitty,
  iTerm2, VS Code).
- **OSC 633** (VS Code superset) when present — richer `E` command text, `P`
  cwd/property reporting.
- **OSC 9** — completion/notification → feeds Crew's existing tray/notification.
- **OSC 7** — cwd reporting → can refresh the Assets panel root.

`blocks.ts` turns these marks into a **Block model**: `{id, promptStart,
outputStart, end, exitCode?, cwd?, durationMs}`. Blocks power:

- **Jump-to-prompt** (`⌘↑`/`⌘↓`) between agent turns / commands.
- **Exit-code gutter decorations** (✓/✗) + overview-ruler marks — a
  generalization of today's prompt-landmark ticks (which become "block start"
  marks; the existing yellow-row feature is subsumed).
- **Copy-output-only** and **fold long output** (later phase).

**Fallback when no marks exist:** if an agent emits no OSC 133 (most CLIs today),
`blocks.ts` synthesizes coarse blocks from the same signal the terminal already
uses — a submit (Enter) starts a block, reusing the current `markPrompt` trigger
in `CrewTerminal`. So the feature degrades to *exactly today's behaviour* and
gets sharper when marks are present.

### 6.5 `crew-hook` shim (exact marks)

A tiny `crew-hook.sh` (and a Copilot/Claude wrapper variant) that emits OSC 133
`A/B/C/D` and OSC 9. `SessionManager` injects it via env at spawn (e.g.
`PROMPT_COMMAND`/`precmd` for shells; a thin wrapper for agents that support a
prompt hook). Opt-in per preset. This turns Crew's *heuristic* detection into
*exact* per-command state and gives every session real blocks. The detection
engine in `main` can consume the same OSC events (via `shared/osc.ts`) as its
highest-confidence signal — tightening the "money transition" (WORKING →
WAITING) the SPEC cares about, with zero change to its public behaviour.

### 6.6 What changes in `main`

Nothing structurally. Optionally, `SessionManager` gains: (1) env injection for
`crew-hook`, and (2) reuse of `shared/osc.ts` to upgrade detection confidence.
Both are additive and independently shippable.

---

## 7. Crew-specific improvements unlocked (the "why custom")

Owning the layer makes these natural instead of hacks:

1. **Command/agent blocks** — visually delimited turns with exit status and
   duration; jump between them; collapse noisy tool output.
2. **Agent-aware affordances** — the existing approval bar (Approve/Deny/Enter/
   Esc) can anchor to the *detected approval block* and show inline at that row.
3. **Prompt landmarks → block boundaries** — today's yellow-row spotting aid
   becomes principled block starts, still with overview-ruler ticks.
4. **Inline images** — agent-produced plots/screenshots render in-terminal and
   cross-link to the Assets panel.
5. **Completion notifications** — OSC 9 from a finished agent flows into Crew's
   tray badge/notification path.
6. **cwd awareness (OSC 7)** — Assets panel root follows the agent's cwd.
7. **Future engine swap** — native/WASM quality without touching any of the
   above.

YAGNI guard: only #1 (blocks, with the Enter-fallback) and #3 are required to
prove the seam. #2/#4/#5/#6 are phased and independently valuable.

---

## 8. Migration & rollout

Behaviour-preserving, incremental, and safe to land alongside other work.

- **Phase 0 — Seam (no user-visible change).** Add `terminal/engine.ts` +
  `xterm-engine.ts` + `pool.ts` + `CrewTerminal.tsx` reproducing today's
  behaviour exactly (parity checklist = G2). Enable `addon-webgl` with fallback.
  Cut `SessionView`/`App` over from `TerminalView`/`terminal-pool` to
  `CrewTerminal`/`pool` in one commit. Old files deleted only at the end.
- **Phase 1 — OSC + blocks (invisible plumbing).** Land `shared/osc.ts` (+ unit
  tests) and `blocks.ts` with the Enter-fallback wired to existing landmark
  visuals. No new UI yet.
- **Phase 2 — Block UX.** Jump-to-prompt, exit-code gutter/ruler decorations,
  copy-output-only, fold. Behind a setting, default on.
- **Phase 3 — Richer capabilities.** `crew-hook` shim (exact marks + detection
  upgrade), `addon-image`, `addon-ligatures`, OSC 9 notifications, OSC 7 cwd.
  Each opt-in.
- **Future.** `GhosttyWasmEngine` evaluation when libghostty-vt tags a stable
  release (§11).

Each phase is shippable and reversible; the app is releasable after every phase.

---

## 9. Testing strategy

Use the project's existing gates (`npm run typecheck`, `npm test` (vitest),
`npm run build`, `npm run test:e2e`).

- **Unit (vitest):** `shared/osc.ts` gets a `osc.test.ts` in the style of the
  detection-engine tests — dependency-free, table-driven over real captured
  sequences (133 A/B/C/D, 633 E/P, 9, 7), including partial/split-chunk marks
  (OSC can arrive across two PTY writes). `blocks.ts` block-assembly tests.
- **Adapter contract test:** a shared suite run against `XtermEngine` (and any
  future engine) asserting the `TerminalEngine` contract: write→readLine,
  resize/fit math incl. bottom-row cap, markRow/decoration lifecycle, dispose.
- **E2E (Playwright, `test/e2e/crew.e2e.mjs`):** extend to the new terminal —
  create session, type, verify echo, drag-drop path insertion, prompt landmark
  appears, jump-to-prompt moves the viewport, rename/restart/close, and the
  existing assertion of **zero renderer/main errors**.
- **Manual parity checklist (G2):** scrollback across tab switch; focus after
  grid reorder/regroup; fit with JetBrains Mono late-load; OSC-8 opens browser;
  asset path click opens Assets; theme.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Parallel session owns `TerminalView.tsx` + `terminal-pool.ts`** (`.crew-progress.md`: prompt-landmark feature — "never stage them") | Build CrewTerm as **new files** under `src/renderer/terminal/`; do **not** edit the owned files. Cut over `SessionView`/`App` imports in a single, clearly-scoped commit **after** coordinating/rebasing on that session's merge. Reproduce the landmark feature via the engine so nothing is lost. Never `git add -A`. |
| WebGL context loss (research §2) | Canvas/DOM fallback on `webglcontextlost`; dispose+re-add addon; covered by adapter test. |
| OSC marks split across PTY chunks | `shared/osc.ts` is a stateful streaming parser (like `detection.ts`'s buffer); unit-tested with split inputs. |
| Reaching into xterm internals for cell height (today) | Replaced by explicit `fit(contentHeightPx)`; if the private field is still needed, it's isolated to the adapter and guarded. |
| Scope creep into a full emulator | Hard non-goal (§2); engine stays xterm-backed; blocks are a layer, not a parser rewrite. |
| Windows parity (0.3.1) | No native/macOS-only code in committed scope (A3); addons are cross-platform. |
| Perf (many terminals) | `addon-webgl` + keep the existing off-screen pooling; SPEC §15 cap-scrollback stance retained (8,000 lines). |

---

## 11. Future directions (documented, not in committed scope)

Enabled cheaply by the §6 seam. Revisit per driver:

- **Path D — libghostty-vt (WASM) engine.** Replace xterm's VT parser/state with
  Ghostty's SIMD core (MIT, compiles to WASM; Ghostty ships `example/wasm-vt`).
  Gains full VT correctness + Kitty graphics/keyboard protocols. Blocked on a
  stable libghostty API tag (currently public alpha).
- **Path E — native NSView + libghostty (Metal).** Native GPU quality on macOS
  (prior art: OrbStack embeds Ghostty this way). macOS-only; NSView renders above
  web content (limits overlays). Highest quality ceiling.
- **Path F — Rio `sugarloaf` WASM + WebGPU** renderer inside Chromium. Cross-
  platform GPU in-web; React overlays compose normally. Blocked on WebGPU-in-
  Electron maturing.
- **Path G — tmux/Zellij session backend** for *persistence* (agents survive a
  Crew crash/restart), named sessions, detach/attach. Separate concern from the
  terminal component; the `TerminalEngine` is agnostic to it.

All four implement or sit beneath the same `TerminalEngine`, so none require
rewriting the block layer, the React view, or `main`.

---

## 12. References

Terminal-landscape research (2024–2025), primary sources:

- Ghostty / libghostty-vt (MIT, Zig/C ABI, WASM examples): <https://github.com/ghostty-org/ghostty> · <https://mitchellh.com/writing/libghostty-is-coming> · <https://github.com/ghostty-org/ghostty/tree/main/example> · <https://libghostty.tip.ghostty.org/>
- xterm.js 5.5 + addons (MIT): <https://github.com/xtermjs/xterm.js/discussions/5022> · webgl README <https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md> · reflow bug <https://github.com/xtermjs/xterm.js/issues/5213> · ligature atlas bug <https://github.com/xtermjs/xterm.js/issues/5246>
- VS Code shell integration / OSC 633 (the "own a layer over xterm" precedent): <https://code.visualstudio.com/docs/terminal/shell-integration> · <https://terminfo.dev/extensions/osc-633-vscode>
- OSC 133 / FinalTerm semantic prompts: <https://vtdn.dev/docs/osc/osc133/> · <https://deepwiki.com/ghostty-org/ghostty/9.3-osc-133-prompt-marking>
- iTerm2 escape codes (OSC 7/8/9, inline images OSC 1337): <https://iterm2.com/3.2/documentation-escape-codes.html>
- Kitty keyboard + graphics protocols: <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>
- Rust cores — alacritty_terminal / vte (Apache-2.0): <https://github.com/alacritty/alacritty/tree/master/alacritty_terminal> · <https://docs.rs/vte/0.15.0/vte/> ; termwiz/wezterm-term (MIT): <https://docs.rs/termwiz/latest/termwiz/>
- Rio / sugarloaf (MIT, WebGPU/WASM): <https://github.com/raphamorim/rio/tree/main/sugarloaf>
- Warp (open-sourced, AGPL core) — blocks UX reference: <https://github.com/warpdotdev/warp>
- Zellij (MIT) — session-model reference: <https://github.com/zellij-org/zellij>
- Native embedding prior art: OrbStack+Ghostty <https://github.com/orbstack/ghostty-up> · Zed embeds alacritty_terminal <https://github.com/zed-industries/zed>
- Electron native window handle: <https://www.electronjs.org/docs/latest/tutorial/native-code-and-electron>

Internal: `SPEC.md` (§4 non-goals, §5 detection/crew-hook, §15 tech risks);
`src/renderer/terminal-pool.ts`; `src/renderer/components/TerminalView.tsx`;
`src/main/session-manager.ts`; `src/shared/detection.ts`.
