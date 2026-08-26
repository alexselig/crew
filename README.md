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

Resuming a session normally reattaches the original conversation, so the agent
replays its whole `events.jsonl`. That is exact, but the cost scales with the
log — a 0.5 MB history costs well over a million tokens, and a multi-megabyte
one cannot be replayed at all, which is how a long-running session becomes
unresumable.

**Settings → Restored context → Brief** takes the other route. Crew starts a
fresh conversation and types in a pointer to that session's *handoff brief*: a
~1–2k token summary rebuilt from data Copilot already keeps on disk — its own
compaction checkpoints, the files the work touched, the commits it made, and
your last few instructions.

```
npm run handoff          # rebuild every brief into ~/.crew/handoffs
```

Generating a brief reads only the local session store, so it costs **no tokens
at all**. To keep them fresh automatically:

```
cp scripts/com.crew.handoff.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.crew.handoff.plist
```

Notes on the trade-off:

- A brief is a summary; exact snippets and passing remarks are lost. But a long
  conversation is *already* summarised — those checkpoints are the compaction —
  so on big sessions you are comparing a brief against a summary, not verbatim
  recall.
- Briefs cite file paths and commit hashes, so the agent re-reads the current
  repo rather than trusting a transcript describing code you have since changed.
- Nothing is deleted. The original id is preserved as `priorSessionId`, and the
  full transcript stays one command away: `copilot --resume=<id>`.
- The primer is typed into the prompt but **never submitted**, so restoring a
  roster of dozens of sessions costs nothing until you engage with one.

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
