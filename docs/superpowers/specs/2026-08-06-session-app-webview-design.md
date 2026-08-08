# Session "App" pane — a live webview of the app you're building

**Status:** Implemented in v0.4.6 (shipped 2026-08-08). This document is the original design proposal, kept for context.
**Date:** 2026-08-06
**Author:** brainstorming session (decisions made autonomously; user to review)

## Summary

Add an **"App"** view to a session, selectable from the pane toggle next to
**Terminal** and **Transcript**. When the agent working in a session is building a
web app and a local dev server is running (or can be started), the App pane shows
that app live inside Crew via an Electron `<webview>` — so you can watch the thing
you're building without leaving Crew or juggling a browser window.

## Feasibility (validated)

A throwaway spike confirmed the core mechanism works in Crew's Electron (31.x):
an Electron `<webview>` with `webviewTag: true` loaded a `http://127.0.0.1:PORT`
page and rendered its content (guest DOM read back the expected marker; no
load failure). So this is definitely buildable; the rest is UX + wiring.

Two mechanisms already exist and are reused:

- **Dev-server launcher** (`src/main/launcher.ts`): detects framework, picks a
  free port, runs `npm run dev` (Vite/Next/CRA/static/python), probes the URL,
  and tracks running state. Already exposed to the renderer via the tracker's
  `launchProject` / `stopProject` / `getRunningServers` IPC.
- **PTY output stream** (`src/main/session-manager.ts` `proc.onData → emit('output')`):
  the single choke point where a URL detector can watch a session's output.

## Goals / non-goals

**Goals (v1)**
- Show the app for a session in an in-app pane, with minimal setup.
- "Just works" when the agent starts its own dev server and prints a URL.
- A one-click **Launch app** fallback when nothing is running but the working
  dir is launchable.
- Basic controls: reload, open-in-browser, and stop (when Crew launched it).

**Non-goals (v1 — YAGNI)**
- No arbitrary internet URLs — **localhost / 127.0.0.1 http(s) only**.
- No browser chrome beyond the essentials (no back/forward history, no tabs,
  no in-pane devtools, no bookmarks).
- No multi-app-per-session. One app URL per session.
- No persistence of the app URL across app restarts (re-detected on demand).

## How Crew decides which app to show (the crux)

**Hybrid, detect-first:**

1. **Auto-detect from the session's own terminal output.** Most agents run
   `npm run dev` themselves; the dev server prints `Local: http://localhost:5173`
   (Vite), `- Local: http://localhost:3000` (Next), etc. A small pure matcher
   `detectDevUrl(text)` scans the session's output stream and captures the most
   recent `http(s)://(localhost|127.0.0.1):<port>` URL. Stored on the session as
   `appUrl`. Zero configuration — the App tab simply appears once a URL shows up.

2. **Launch fallback.** If no URL has been seen but the session's `cwd` is
   launchable (the launcher can resolve a framework/dev script), the App pane
   shows a **Launch app** button that reuses the existing launcher to start the
   dev server for that cwd and adopts its URL.

This matches the original ask: an App tab *"if an app is running or can be opened
in Crew."*

## Architecture

```
 agent runs `npm run dev`  ──prints──▶  PTY output
                                             │  (session-manager proc.onData)
                                             ▼
                                    detectDevUrl(data)  ──▶ session.appUrl set
                                             │                     │ roster broadcast
                                             ▼                     ▼
                            (fallback) launcher.run(cwd) ──▶ renderer: "App" tab appears
                                                                   │ user selects App
                                                                   ▼
                                                        AppPane renders <webview src=appUrl>
```

### Components (small, isolated units)

| Unit | File | Responsibility | Depends on |
|------|------|----------------|------------|
| `detectDevUrl(text)` | `src/shared/detection.ts` | Pure: extract a localhost dev URL from a chunk of terminal text; null if none. Unit-tested. | — |
| App-URL tracking | `src/main/session-manager.ts` | Feed output through `detectDevUrl`; set/clear `session.appUrl`; debounced roster emit (reuse existing `rosterDirty` debounce). | detectDevUrl |
| `SessionInfo.appUrl?` | `src/shared/types.ts` | Surface the detected URL + a `appLaunchable` boolean to the renderer. | — |
| webview enablement | `src/main/index.ts` | `webPreferences.webviewTag = true`; a `will-attach-webview` hardener (strip node, pin a partition, allow only http(s) localhost). | — |
| `AppPane` | `src/renderer/components/AppPane.tsx` | The `<webview>` + a thin toolbar (URL, Reload, Open-in-browser, Stop/Launch); load/fail/empty states. | api (launch/stop) |
| Pane toggle + render | `src/renderer/components/SessionView.tsx` | Add **App** to `.pane-toggle` (shown when `appUrl` set or launchable); render `AppPane` when `pane === 'app'`. | AppPane |
| styles | `src/renderer/styles.css` | `.app-pane`, `.app-pane__bar`, states. Reuses `.term-wrap` column. | — |

### Webview security posture
- Dedicated `partition="persist:crewapp"` (isolated from the app's own origin).
- No `nodeintegration`; `contextIsolation` on (webview default).
- `will-attach-webview`: reject any `src` that isn't `http(s)://localhost|127.0.0.1`.
- `setWindowOpenHandler` on the guest → open external (no in-app popups), matching
  the main window's existing policy.
- Host-page CSP is unaffected (a `<webview>` is an out-of-process WebContents, not
  framed content), so no CSP relaxation is needed — a real advantage over `<iframe>`
  (which the current `frame-src crew-asset:` CSP blocks).

### Pane-toggle visibility
Today `.pane-toggle` only renders when the Enhanced Terminal beta is on
(Terminal | Transcript). This design decouples **App** from that flag: the toggle
renders when *either* Transcript is available (enhanced on) *or* an app is
available (`appUrl` set / launchable). So the App pane works for everyone, not
just enhanced-terminal users. Terminal is always the default/first tab.

## Data flow & lifecycle
- **Detect:** output → `detectDevUrl` → if changed, set `session.appUrl`, debounced roster broadcast → "App" tab appears.
- **Show:** selecting App mounts `AppPane`, which sets `<webview src={appUrl}>`.
- **Launch:** if no `appUrl` but launchable, "Launch app" → `launchProject(cwd)` → on ready, adopt URL → webview loads.
- **Stop/close:** if Crew launched the server, "Stop" calls `stopProject`. On session close, stop any Crew-launched server (existing `stopAll` covers app quit).
- **Server down / not ready:** webview `did-fail-load` → retry-with-backoff + a "waiting for dev server…" state.

## Error handling
- No URL + not launchable → App tab hidden (nothing to show).
- Launchable but not started → App pane shows the Launch affordance, not an error.
- `did-fail-load` (ECONNREFUSED before the server is up) → transient "starting…" with auto-retry; a manual Reload always available.
- Detected URL becomes unreachable (server stopped) → non-blocking banner + Reload.

## Testing
- **Unit:** `detectDevUrl` across Vite/Next/CRA/webpack/python/rails output lines, ANSI-wrapped lines, and negative cases (random URLs, non-localhost) — add to `test/detection.test.ts`.
- **Feasibility:** already proven by the spike (webview renders a localhost app).
- **e2e (optional):** spin a tiny localhost server, create a session, assert the App tab appears and the webview reaches `did-finish-load`.

## Rollout / risks
- `<webview>` is a mature but "special" Electron element; enabling `webviewTag`
  slightly widens the renderer's surface — mitigated by the localhost-only +
  isolated-partition + no-node posture above.
- Some dev servers set `X-Frame-Options`/CSP that block framing — **not a problem
  for `<webview>`** (out-of-process, unlike `<iframe>`), another reason for this choice.
- Detection false-negatives (unusual URL formats) degrade gracefully to the
  Launch fallback; false-positives are bounded to localhost.

## Estimated surface
~1 new pure function (tested), 1 new renderer component, ~4 small edits
(types, session-manager, index webPreferences, SessionView), plus CSS. No new
runtime dependency. Reuses the existing launcher + tracker IPC.
