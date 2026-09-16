# Crew

> A menu-bar **mission control** for your AI coding terminals. Each session gets
> its own character and editable label, animates while the agent works, and flips
> to a **red dot** the moment it's waiting on *you*.

Run several AI CLI agents (Claude Code, Copilot CLI, custom commands) at once and
never lose track of which one needs input. Crew **owns the PTYs**, so it sees the
full output stream and can reliably tell *working* from *waiting-for-you* — then
surfaces a menu-bar badge with a count and a native notification.

Crew keeps its roster and captured transcripts on disk. Agent CLIs, update
checks, and links you open can use the network.

## Install

macOS builds are **Developer ID signed and notarized by Apple**, for both
Apple Silicon and Intel.

```bash
curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash
```

Or download **`Crew-<version>-arm64.dmg`** (Apple Silicon) or
**`Crew-<version>-x64.dmg`** (Intel) from the
[latest release](https://github.com/alexselig/crew/releases/latest) and drag Crew
into Applications.

The installer verifies the download before quitting Crew, stages replacement on
the same volume, and restores the previous app if launch cannot be confirmed.
It does not delete session data or remove Gatekeeper protection. Launch
confirmation checks process presence, not full application health. A power loss
or forced installer termination may require manual recovery: inspect the hidden
`.crew-install.*` staging directories beside the app for `previous.app` before
removing a leftover `.crew-install.lock` or any backup.

On Windows, download **`Crew-Setup.exe`** from the same release. Windows builds
are currently unsigned, so SmartScreen may display a warning.

Maintainers: see [`RELEASING.md`](./RELEASING.md) for the full release flow
(`scripts/publish.sh`) and [`MACOS-SIGNING.md`](./MACOS-SIGNING.md) for how
releases are signed + notarized.

## Features (v0.1)

- Launch owned sessions: **Claude Code**, **Copilot CLI**, **Shell**, or any
  custom command + working directory (+ optional initial prompt).
- New Copilot sessions default to **GPT-6 Astra** (`gpt-6-astra`). The **Model**
  dropdown reads supported choices from your installed CLI (`copilot completion
  bash`), not a hard-coded catalog. Account access remains subject to Copilot.
  The initial model choice is saved for new conversations and duplication.
  Native resume honors Copilot's persisted selection, including later `/model`
  changes; existing conversations are not switched back to their launch model.
- New sessions use the selected session's working directory (or home when none
  is selected), with the directory visible beside the agent/model controls.
- **Named Custom Views** organize sessions into a personal ranked queue. Search
  the full roster in a two-column organizer, drag sessions directly into rank,
  and choose whether a view shows only ranked work or ranked work followed by
  every remaining session.
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
- **Copilot autopilot indicator** follows the CLI's persisted mode, including
  resumed sessions, and refreshes about once a second while running. Complete
  mode events are read asynchronously; split writes and large tool output do
  not discard mode changes. Sleeping/exited sessions are not shown as autonomous.
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
- Changing an unstarted brief successor to **Transcript** resumes its original
  conversation rather than opening an empty successor. Retrying a failed launch
  preserves its conversation IDs and reloads the brief when available.
- Older roster entries without a recorded provider ID retain the CLI's
  `--continue` fallback, with a warning to verify the selected conversation.
  Crew cannot guarantee which historical conversation an ID-less entry belongs to.
- Optional initial prompts for new Copilot sessions use the same native startup
  flag instead of a timer typing into a terminal that may not be ready.

## Storage safety

Roster saves use flushed temporary files and atomic replacement, with rotated
backups and dated snapshots. Unix builds also flush directory entries. Recovery
validates saved data and tries backups even when the primary file is missing;
unrecoverable or inaccessible stores are protected from being overwritten by an
empty roster. Startup publishes the complete restored roster in one batch,
never a partially restored prefix.

Optional text capture retains buffered output after write failures and tracks
partial writes so retries do not duplicate bytes. Storage failures produce native
warnings; affected terminal output is paused until capture flushes successfully.
Roster changes that could not be saved remain in memory and retry on subsequent
saves. **Do not quit while storage errors remain unresolved.**

These are failure safeguards, not a zero-loss guarantee. Unsaved memory cannot
survive process termination, Windows does not get Unix directory flushing, and
same-disk backups do not protect against disk loss. Text capture is not an archive
of provider events, attachments, or exact terminal state.

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

The focused E2E harness (`test/e2e/crew.e2e.mjs`) runs an isolated browser
integration for Custom Views: it creates a `Release queue`, drags sessions into
rank, verifies roster/grid order, reloads to confirm persistence, removes a
ranked session, deletes the active view, and asserts zero renderer errors.

## Status

See [`SPEC.md`](./SPEC.md) for the full design, MVP scope (§13), and the v0.1
implementation notes (§17), and [`DESIGN.md`](./DESIGN.md) for the visual design
system (Obsidian palette, typography, motion, state model). The highest-value next
step is calibrating the prompt/spinner signatures against real Claude Code /
Copilot CLI transcripts.
