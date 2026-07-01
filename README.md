# Crew

> A menu-bar **mission control** for your AI coding terminals. Each session gets
> its own character and editable label, animates while the agent works, and flips
> to a **red dot** the moment it's waiting on *you*.

Run several AI CLI agents (Claude Code, Copilot CLI, custom commands) at once and
never lose track of which one needs input. Crew **owns the PTYs**, so it sees the
full output stream and can reliably tell *working* from *waiting-for-you* — then
surfaces a menu-bar badge with a count and a native notification.

100% local. No network, no telemetry, no session content leaves your machine.

## Features (v0.1)

- Launch owned sessions: **Claude Code**, **Copilot CLI**, **Shell**, or any
  custom command + working directory (+ optional initial prompt).
- Embedded **xterm.js** terminal per session — full interaction in-app,
  scrollback preserved across tab switches.
- **State detection** (`WORKING` / `WAITING_INPUT` / `WAITING_APPROVAL` / …) via
  output quiescence, prompt/approval regexes, and a debounced silence fallback,
  guarded against false red dots during post-input think-time.
- Per-session **unique character** + **editable label**, persisted by
  `preset + cwd` so relaunching a job reuses its identity.
- Menu-bar **badge + count**, context-menu jump-to-waiting, and a native
  **notification** when a session starts waiting.
- Needs-you-first roster sort; restart / dismiss; graceful error handling.

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
implementation notes (§17). The highest-value next step is calibrating the
prompt/spinner signatures against real Claude Code / Copilot CLI transcripts.
