# Crew

> A menu-bar **mission control** for your AI coding terminals. Each session gets
> its own character and editable label, animates while the agent works, and flips
> to a **red dot** the moment it's waiting on *you*.

Run several AI CLI agents (Claude Code, Copilot CLI, custom commands) at once and
never lose track of which one needs input. Crew **owns the PTYs**, so it sees the
full output stream and can reliably tell *working* from *waiting-for-you* — then
surfaces a menu-bar badge with a count and a native notification.

100% local. No network, no telemetry, no session content leaves your machine.

## Install

Crew is **signed & notarized by Apple**, so it opens with no security warnings on
macOS (Apple Silicon, arm64).

```bash
curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
```

Or download **`Crew-<version>-arm64.dmg`** from the
[latest release](https://github.com/alexselig/crew/releases/latest) and drag Crew
into Applications.

Maintainers: see [`RELEASING.md`](./RELEASING.md) for the full release flow
(`scripts/publish.sh`) and [`MACOS-SIGNING.md`](./MACOS-SIGNING.md) for how
releases are signed + notarized.

## Features (v0.1)

- Launch owned sessions: **Claude Code**, **Copilot CLI**, **Shell**, or any
  custom command + working directory (+ optional initial prompt).
- New Copilot sessions default to **GPT-6 Astra** (`gpt-6-astra`). The **Model**
  dropdown reads supported choices from your installed CLI (`copilot completion
  bash`), not a hard-coded catalog. Account access remains subject to Copilot.
  The selected model is saved with the session and retained on restore and
  duplication; existing sessions are not switched to Astra.
- New sessions use the selected session's working directory (or home when none
  is selected), with the directory visible beside the agent/model controls.
- Embedded **xterm.js** terminal per session — full interaction in-app,
  scrollback preserved across tab switches.
- **Beta: Enhanced Terminal Interface** (Settings, off by default) — an
  app-wide, Crew-owned terminal engine with GPU (WebGL) rendering, Unicode 11
  widths, inline images (Sixel/iTerm2), OSC 133 command blocks with **exit-code
  ruler marks** and **jump-to-prompt** (⌘↑/⌘↓), and an opt-in zsh/bash
  `crew-hook` for exact per-command marks. Design + test map under
  [`docs/superpowers/`](./docs/superpowers/).
- **State detection** (`WORKING` / `WAITING_INPUT` / `WAITING_APPROVAL` / …) via
  output quiescence, prompt/approval regexes, and a debounced silence fallback,
  guarded against false red dots during post-input think-time.
- Per-session **unique character** + **editable label**, persisted by
  `preset + cwd` so relaunching a job reuses its identity.
- **App preview pane** — when a session is building a web app, an **App** tab
  (next to Terminal/Transcript) renders its running dev server live inside Crew.
  Crew auto-detects the local dev-server URL from the session's output (Vite,
  Next, CRA, …) — you start the server in the terminal, Crew just mirrors it.
  Loopback-only and hardened (isolated session, node integration off).
- Menu-bar **badge + count**, context-menu jump-to-waiting, and a native
  **notification** when a session starts waiting.
- Needs-you-first roster sort; restart / dismiss; graceful error handling.

## Restored context: transcript vs brief

**Auto** (the default) and **Transcript** use the agent's native conversation
resume. The provider manages its own context window and compaction. Crew no
longer switches to a summary just because an event log exceeds 2 MiB: serialized
file bytes, especially images and tool output, do not measure context tokens.

**Settings → Restored context → Brief** takes the other route. Crew starts a
fresh Copilot conversation and automatically loads that session's *handoff brief*:
a summary rebuilt from data Copilot already keeps on disk — its own
compaction checkpoints, the files the work touched, the commits it made, and
your last few instructions.

```
npm run handoff          # rebuild every brief into ~/.crew/handoffs
```

Generating a brief reads only the local session store, so generation itself
costs **no inference tokens**. To keep them fresh automatically:

```
cp scripts/com.crew.handoff.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.crew.handoff.plist
```

Notes on the trade-off:

- A brief is a clipped summary, not a lossless backup. Details can be omitted,
  and tool-result/attachment preservation is not provided by this feature.
- Briefs cite file paths and commit hashes, so the agent re-reads the current
  repo rather than trusting a transcript describing code you have since changed.
- Crew does not delete provider history. The original id is preserved as
  `priorSessionId`; native resume remains available while the provider's
  underlying data exists: `copilot --resume=<id>`.
- Saved sessions remain asleep until opened. On wake, a fresh brief-backed
  conversation receives its context-loading prompt via `--interactive`:
  **no manual submission is required**. This turn may consume Copilot credits.
  It asks the agent to read the historical context, acknowledge it, and wait
  for your next instruction, not execute old tasks.
- Crew verifies the full conversation ID inside the brief rather than trusting
  the filename prefix. Missing/ambiguous briefs never silently replace native
  context with an empty conversation. Existing native conversations are not
  repeatedly primed with their predecessor's brief.
- Optional initial prompts for new Copilot sessions use the same native startup
  flag instead of a timer typing into a terminal that may not be ready.

The durable session vault described in
[`docs/superpowers/specs/2026-09-11-session-preservation-design.md`](docs/superpowers/specs/2026-09-11-session-preservation-design.md)
is a separate design; these context-loading improvements do not implement
lossless archival or guarantee recovery of provider data that has been removed.

## Architecture

```
Electron main (Node)              Renderer (React + xterm.js)
─ session-manager  ── owns ──▶ PTYs (node-pty)
─ detection engine (pure)   ◀── IPC ──▶  ─ roster / cards / characters
─ tray + notifications                    ─ embedded terminals (pooled)
─ JSON store (userData)                   ─ new-session modal
```

- `src/main/*` — app lifecycle, PTY-owning session manager, per-session
  `StateDetector`, tray, JSON persistence, presets, characters.
- `src/preload/index.ts` — narrow, typed `window.crew` contextBridge surface.
- `src/renderer/*` — React UI + a terminal pool that keeps one xterm alive per
  session.
- `src/shared/*` — types, the IPC contract, and the dependency-free detection
  engine (unit-tested).

## Develop

```bash
npm install
npm run rebuild:native   # rebuild node-pty for Electron's ABI (once after install)
npm run dev              # run in development
```

## Verify

```bash
npm run typecheck        # main / preload / renderer
npm test                 # detection-engine unit tests
npm run build            # production build
npm run test:e2e         # Playwright end-to-end against the built app
```

The E2E harness (`test/e2e/crew.e2e.mjs`) launches the real app and drives every
button — create a session, type into the terminal, rename, change character,
detect the waiting transition, restart, close, and the error path — asserting
zero renderer/main-process errors.

## Status

See [`SPEC.md`](./SPEC.md) for the full design, MVP scope (§13), and the v0.1
implementation notes (§17), and [`DESIGN.md`](./DESIGN.md) for the visual design
system (Obsidian palette, typography, motion, state model). The highest-value next
step is calibrating the prompt/spinner signatures against real Claude Code /
Copilot CLI transcripts.
