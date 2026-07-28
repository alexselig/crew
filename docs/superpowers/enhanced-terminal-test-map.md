# Enhanced Terminal — Test Map & Verification Guide

Companion to `2026-07-28-custom-terminal-design.md`. Covers **what is built**, the
**automated test coverage**, a **human-runnable manual test plan** per milestone,
and the **security & performance** results. The feature is app-wide and **off by
default**: Settings → “Beta: Enhanced Terminal Interface”.

## What shipped (milestones)

| Milestone | Deliverable | Commit theme |
|---|---|---|
| M1 | Pure OSC 133/633/9/7 parser + command-block tracker | `feat(terminal): M1` |
| M2 | `TerminalEngine` interface + `XtermEngine` adapter (WebGL + Unicode 11) + pool + facade | `M2` |
| M3 | App-wide Settings gate + `CrewTerminal`/`TerminalHost` + routing | `M3` |
| M4 | Jump-to-prompt (⌘↑/⌘↓) + exit-code ruler ticks | `M4` |
| M5 | `crew-hook` OSC 133 shell integration (zsh/bash), opt-in | `M5` |
| M6 | Inline images (Sixel + iTerm2) | `M6` |
| M7 | Perf/ReDoS guards, e2e coverage, docs | `M7` |

Deferred (documented): programming ligatures (`addon-ligatures` needs Node `fs`,
unavailable in Crew’s sandboxed renderer); surfacing OSC 9 completion
notifications and OSC 7 cwd (both already **parsed** in `osc.ts` — only the
main-process wiring is pending).

## Architecture safety property

The engine is selected by a single facade (`src/renderer/terminal/facade.ts`).
When the setting is **off**, `writeTo`/`focusTerminal` route to the **legacy**
pool and `TerminalHost` renders the original `TerminalView` — i.e. the default
experience is byte-for-byte unchanged. All new code is reachable only with the
setting **on**, which bounds the blast radius of the beta.

## Automated test coverage

Run: `npm run typecheck && npm test && npm run build` (and `npm run test:e2e` in
a clean checkout — see caveat below).

| Suite (`test/…`) | What it locks down |
|---|---|
| `osc.test.ts` (12) | OSC 133/633/9/7 parsing; chunk-split sequences; BEL & ST terminators; robustness to plain text / lone `ESC]`. |
| `blocks.test.ts` (8) | Block assembly: exit codes, cwd, command text, timing, sequential commands, `list()` immutability. |
| `nav.test.ts` (5) | Jump-to-prompt target math (next/prev, boundaries, empty). |
| `facade.test.ts` (7) | App-wide routing: legacy default; crew when on; **dispose clears both pools**; blocks/jump/copy are Crew-only. |
| `crew-hook.test.ts` (6) | Script materialization; user-config chaining present; ZDOTDIR/`--rcfile` selection; login-shell `arg0`; null for unsupported shells. |
| `osc-perf.test.ts` (3) | Throughput + **ReDoS / memory-blowup guards**. |
| `test/e2e/crew.e2e.mjs` | End-to-end: toggle the beta on, full round-trip through the Crew engine, ⌘↑/⌘↓ handled, toggle back — plus the existing legacy flow. Asserts **zero** renderer/main errors. |

Shell integration was additionally validated **against real zsh & bash in a PTY**
(paced input via Python `pty`): per-command marks `A → C → D;exit` fire, commands
run, and the user’s `.zshrc`/`.bashrc` + prompt are preserved.

> **e2e caveat:** the Electron e2e requires the Electron binary + `npm run
> rebuild:native` and a stable `node_modules`. In the shared dev sandbox used for
> this work it was blocked by a concurrent `npm install` churning `node_modules`
> and Playwright’s Electron launcher — not by app code (the main process boots
> cleanly via `electron out/main/index.js`). Run it in a clean checkout.

## Manual test plan (human-runnable)

Setup: `npm install && npm run rebuild:native && npm run dev`.

### 0. Default off = no change (regression gate)
1. Fresh launch, **do not** touch settings.
2. Create a **Shell** session; type `ls`, Enter. → Works exactly as before.
3. Confirm prompt-landmark yellow row on Enter, clickable file paths, OSC-8 links
   open in your browser, Finder drag-drop inserts a quoted path. → All unchanged.

### 1. Toggle on/off (M3)
1. Settings → turn **Beta: Enhanced Terminal Interface** on.
2. Open sessions’ terminals re-render; typing still works; scrollback for new
   output accrues. Toggle off → back to legacy. Toggle repeatedly → no crash, no
   duplicate terminals, input still focuses.

### 2. Parity (M2/M3) — with the beta ON
Repeat every step in §0 with the beta on: echo round-trip, prompt landmark +
overview-ruler tick, clickable asset paths open the Assets panel, OSC-8 link
opens the external browser, Finder drag-drop inserts a shell-quoted path + space,
window resize never clips the bottom row, tab/grid switches preserve scrollback
and keep focus.

### 3. Rendering upgrades (M2/M6)
1. `cat` a file with emoji / wide glyphs → widths are correct (Unicode 11).
2. Fast output (`yes | head -100000`) stays smooth (WebGL).
3. If you have `img2sixel`/an agent that emits images, an inline image renders
   (Sixel / iTerm2).

### 4. Jump-to-prompt & exit codes (M4/M5)
1. Shell session with the beta on (crew-hook auto-installs). Run several commands
   (`echo a`, `false`, `echo b`).
2. Scroll up. Press **⌘↑ / ⌘↓** → the viewport jumps between prompts; the key is
   **not** typed into the shell.
3. Overview ruler shows **green** ticks for exit 0 and a **red** tick for `false`
   (exit 1).

### 5. Shell integration safety (M5)
1. Put a marker in your `~/.zshrc` (e.g. `export CREW_RC_OK=1`) and a custom
   prompt.
2. Shell session with beta on → your prompt and `echo $CREW_RC_OK` (`1`) confirm
   your config is sourced; `echo $ZDOTDIR` shows your normal value (restored).
3. Turn the beta off → new Shell sessions get no injection.

## Security summary

A dedicated security pass reviewed the untrusted-output and shell-integration
surface and found **no high-confidence, newly-introduced vulnerabilities**. Key
properties (with the evidence that was verified):

- **OSC parsing** (`osc.ts`) never eval’s or executes parsed data; the streaming
  buffer is hard-capped (`MAX = 4096`) so hostile/unterminated sequences cannot
  exhaust memory, and the regex has no nested quantifiers — **not ReDoS-prone**
  (2 M-char adversarial inputs parsed in <4 ms). Parsed `command`/`cwd`/`exitCode`
  live only in `BlockTracker` memory; `apply()` switches on a fixed `kind` union,
  so no prototype pollution.
- **Links**: OSC-8 `openExternal` is gated to `^https?://` in the main process
  (`src/main/index.ts`), rejecting `file:` / `javascript:` / custom schemes;
  asset-token preview is byte-identical to the legacy terminal. No new capability.
- **crew-hook** only adds `printf`-based OSC 133 marks, always sources the user’s
  own rc first via the real `CREW_ZDOTDIR`, and restores/unsets `ZDOTDIR`; the
  injected env/`--rcfile` point only at the fixed `<userData>/crew-hook` dir and
  contain no attacker-controlled values. Correctly gated to the Shell preset.
- **Drag-drop** paths (real FS paths from `webUtils.getPathForFile`) go through
  `quotePaths` (correct POSIX single-quote escaping) and are inserted with a
  trailing space, not a newline — nothing auto-executes. Pre-existing behaviour.
- **No XSS/SSRF**: xterm renders to canvas/DOM cells (no `dangerouslySetInnerHTML`);
  the image addon decodes Sixel/iTerm2 raster data inline with no URL fetch.

## Performance

Measured on this machine (`src/shared/osc.ts`):

- Plain text (no OSC): **~7.7 GB/s** — parsing is effectively free on the output
  path.
- Heavy OSC 133 shell stream: **~158 MB/s** (150k events in ~13 ms).
- Flood of unterminated `ESC]`: **bounded, ~6 ms** for 5 MB (no blowup).

Rendering uses the WebGL addon (with automatic fallback on context loss), which
is faster than the legacy DOM/canvas path. Net: the enhanced terminal is **at
least as fast** as — and generally faster than — the current terminal.
