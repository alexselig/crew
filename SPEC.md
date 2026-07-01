# Crew — AI Terminal Session Manager & Viewer

> **Working title:** *Crew* (rename freely — see [Naming](#naming)).
> **One-liner:** A menu-bar "mission control" for your AI coding terminals. Each session gets its own animated character and editable label, runs while the agent is working, and flips to a **red dot** the moment it's waiting on *you*.

---

## 0. Status of key decisions

| Decision | Choice | Notes |
| --- | --- | --- |
| **Form factor** | Menu-bar–style desktop app, web-tech UI (**Electron** + Node backend) | Glanceable tray presence + rich window UI + native OS access. |
| **Session model** | **Manager launches & owns the PTY** | You start sessions from the app; the app is the terminal. Gives rock-solid "waiting vs running" detection. |
| **Primary OS** | macOS (Apple Silicon) | Cross-platform is a later concern; nothing here should hard-block Linux/Windows. |
| **Data locality** | 100% local | No network, no telemetry, no session content leaves the machine. |

Everything below builds on these four.

---

## 1. Problem & vision

When you run several AI coding agents (Claude Code, Copilot CLI, etc.) across multiple terminal windows, you lose track of **which one needs you**. Agents alternate between *working* (thinking, editing, running tools) and *waiting for your next instruction or approval*. Today you have to eyeball every window.

**Crew** turns that pile of terminals into a single, glanceable roster of little characters:

- **Working** → the session's character **runs/animates**; menu bar looks busy-but-calm.
- **Waiting for you** → the character stops and a **red dot** appears; the menu bar shows a red badge with a count; you get a native notification.
- Each session is a **distinct character** with an **editable label** so "PowerPoint agent" ≠ "farm mapper" at a glance.

The result: never leave an agent idle-waiting because you didn't notice, and never interrupt one that's still working.

---

## 2. Goals & non-goals

### Goals
1. Launch and **own** AI terminal sessions from one app (agent presets + custom commands).
2. Reliably detect and display each session's **state**, especially the **waiting-for-user** transition.
3. Make status **glanceable**: menu-bar badge + per-session character + red dot.
4. Let the user **interact** with any session (embedded terminal) without leaving the app.
5. Give each session a **unique character** and an **editable label**, persisted across restarts.
6. **Notify** (native + optional sound) when a session starts waiting.

### Non-goals (for now)
- Not a general terminal replacement / not trying to beat iTerm2 on features.
- Not attaching to arbitrary pre-existing external windows (that's a v2 stretch — see §14).
- No cloud sync, accounts, or multi-user collaboration.
- Not agent-specific business logic beyond state detection + presets.

---

## 3. Primary user

**Alex** — ships several projects in parallel (PowerPoint compete work, a Godot game, a farm mapper, PoseForge, bug-triage tooling). Frequently runs 2–6 AI CLI agents at once and context-switches constantly. Wants to (a) instantly see who needs input, (b) not babysit terminals, (c) keep the whole thing local and low-friction.

---

## 4. Concepts & terminology

- **Session** — one owned PTY running an agent command in a working directory. The atomic unit Crew manages.
- **Character** — the visual avatar assigned to a session (animated sprite/figure). Unique per active session.
- **Label** — human name for a session (auto-suggested, user-editable). e.g. "PPT agent · slideforge".
- **State** — where the session is in its turn cycle (see §5). Drives all visuals.
- **Preset** — a saved way to launch a session (command + default cwd + default character/label pattern).
- **Roster** — the collection of current sessions shown in the main window and tray popover.

---

## 5. Session state model (the core)

Crew models each session as a small state machine. State drives the character animation, the dot color, the menu-bar badge, and notifications.

| State | Meaning | Visual | Needs you? |
| --- | --- | --- | --- |
| `STARTING` | Process spawned, agent not ready yet | Character loading/blinking | No |
| `WORKING` | Agent is actively producing output / thinking / running tools | Character **runs** (looping animation); no dot | No |
| `WAITING_INPUT` | Agent finished its turn, awaiting your prompt | Character idle pose + **red dot** | **Yes** |
| `WAITING_APPROVAL` | Agent is asking a yes/no / permission question | Idle pose + **amber dot** + "?" glyph | **Yes (urgent)** |
| `IDLE` | No activity, but not clearly a prompt (fallback) | Character resting; faint dot | Probably |
| `EXITED` | Process ended normally | Grayed character + tombstone/✔ | No (dismiss/restart) |
| `ERROR` | Process crashed / nonzero exit / detector lost sync | Grayed + red "!" | Maybe (restart) |

### Transitions (happy path)
```
STARTING → WORKING → WAITING_INPUT → (user types) → WORKING → WAITING_INPUT → …
WORKING → WAITING_APPROVAL → (user answers) → WORKING
any → EXITED | ERROR
```

The **money transition** is `WORKING → WAITING_INPUT` (and `→ WAITING_APPROVAL`): that's what fires the red dot, the tray badge increment, and the notification.

---

## 6. State detection engine (the hard part)

Because Crew **owns the PTY**, it sees the full raw output stream (including ANSI/cursor control) and controls stdin. Detection combines layered signals into a debounced, confidence-scored decision. No single signal is trusted alone.

### Signal layers (in priority order)
1. **Semantic hooks (best, if available).** If the agent (or a thin launch wrapper) emits terminal shell-integration marks — OSC 133 command start/end, OSC 9 notifications, OSC 9;4 progress, or a tiny custom OSC status protocol — state is *exact*. Crew ships an optional `crew-hook` shim agents can source to emit `WORKING`/`WAITING` marks. Preferred when present.
2. **Spinner / activity detection.** Working agents animate: braille spinners (`⠋⠙⠹⠸…`), elapsed-time counters, streaming tokens, frequent same-line redraws (lots of `\r`/cursor-up rewrites). High redraw/output frequency ⇒ `WORKING`.
3. **Output quiescence timer.** When the stream goes quiet for `T_quiet` (default ~600–900 ms) *and* activity signals stop, the session is likely done working.
4. **Prompt-signature match.** On quiescence, match the last rendered lines against the agent's **input-prompt regex** (per-preset, configurable). A match ⇒ `WAITING_INPUT`. An approval-question pattern (e.g. "(y/n)", "Allow?", a permission box) ⇒ `WAITING_APPROVAL`.
5. **Bell / notification bytes.** A `BEL` (`\a`) or OSC 9 from the agent is a strong "turn done / attention" signal → nudges toward waiting.
6. **Process-tree CPU heuristic (corroboration only).** Sustained ~0% CPU across the child tree supports "waiting"; spikes support "working". Weak alone (network waits are low-CPU) — used only to break ties.

### Decision policy
- Maintain a rolling **activity score** from signals 2–3 and a **prompt confidence** from 1/4/5.
- Debounce with hysteresis: require the quiet+prompt condition to hold for `T_confirm` (default ~400 ms) before declaring `WAITING_*`, and any fresh output immediately returns to `WORKING`. This prevents flicker between token bursts.
- If quiescent but no prompt match and no hook → `IDLE` (best-effort; still surfaced but lower-priority than a confirmed `WAITING_*`).
- Per-preset tuning: `T_quiet`, `T_confirm`, prompt regex, approval regex, spinner charset are all overridable so new agents can be supported without code changes.

### Why owning the PTY makes this tractable
We don't have to scrape someone else's window or guess from CPU alone — we have the byte stream and know exactly when we last wrote to stdin. "Waiting" ≈ *we haven't received meaningful output for T_quiet since the agent last drew its prompt, and we haven't sent input since.*

> **Open calibration task:** capture real Claude Code + Copilot CLI transcripts to lock down default prompt/spinner regexes and timers. See §16.

---

## 7. UX / UI specification

### 7.1 Menu-bar (tray) — always visible
The tray icon encodes **global** status by priority:

1. **Any `WAITING_*`** → red (or amber if only approvals) badge with **count** of sessions needing you. Highest priority — this is the whole point.
2. **Else any `WORKING`** → subtle "busy" glyph (small running character or pulsing dot). Calm, not alarming.
3. **Else** (all idle/exited/none) → neutral resting icon.

**Click** → popover with a compact roster: each session's character, label, state dot, "since" timer, and a **Jump** button (opens main window focused on that session). A **＋ New Session** action sits at the bottom. Optional secondary-click → quick menu (New Session, Show Window, Preferences, Quit).

### 7.2 Main window
Two-region layout:

- **Left: Roster** — a list/grid of **session cards** (see 7.3). Sortable (needs-you first by default) and reorderable. `＋ New Session` at top.
- **Right: Session view** — the selected session's **embedded terminal** (full xterm.js), with a header showing character + editable label + state pill + actions (Restart, Send-to-front, Duplicate, Close). Because Crew owns the PTY, this embedded terminal *is* where you interact with the agent.

Global affordances: a **"needs you" filter/jump** (cycle through waiting sessions with a keyboard shortcut), quick-switch palette (⌘K style) to jump by label/character.

### 7.3 Session card anatomy
```
┌───────────────────────────────────────────────┐
│  [🦊 running]   PPT agent · slideforge      ●   │  ← character (animated) + label + state dot
│  ~/slideforge · claude code                     │  ← cwd · preset (muted)
│  waiting for you · 12s        [Jump] [⋯]        │  ← state text + since-timer + actions
└───────────────────────────────────────────────┘
```
- **Character** animates per state (runs when working, idle pose + red dot when waiting).
- **Label** inline-editable (click/enter to rename).
- **State dot**: green-ish/animated = working, **red = waiting_input**, amber = waiting_approval, gray = exited.
- **Since-timer**: how long in current state (e.g., "waiting 2m 14s") — helps you triage who's been blocked longest.

### 7.4 Character system
- A **roster of distinct characters** (sprites or vector figures), each with animation states: `run` (working), `idle/wait` (waiting), `sleep` (idle), `gone` (exited).
- **Auto-assignment:** each new session gets the next unused character (stable, deterministic order). No two active sessions share a character.
- **User override:** change a session's character from a picker.
- **Stable identity (nice-to-have):** remember character+label by session identity (e.g. `preset + cwd`) so relaunching "farm mapper" reuses its character.
- **Art source is a decision** (custom art / open sprite pack / emoji-glyph fallback) — see §16. MVP can ship with an emoji/glyph fallback and upgrade art later.

### 7.5 New Session flow
1. Pick a **preset** (Claude Code, Copilot CLI, custom command) or "Custom…".
2. Choose **working directory** (recent dirs remembered; defaults from preset).
3. Optional **initial prompt** to send on launch.
4. Crew spawns the PTY, auto-assigns character, sets a suggested label (from cwd/preset), and opens its terminal.

### 7.6 Empty / edge states
- No sessions → friendly empty state with a big `＋ New Session` and preset shortcuts.
- Session `EXITED`/`ERROR` → card stays (grayed) with **Restart** and **Dismiss**; frees its character on dismiss.

### 7.7 Notifications
- Native macOS notification on `WORKING → WAITING_INPUT` / `WAITING_APPROVAL`: *"🦊 PPT agent needs your input."* Click → jump to that session.
- Optional sound; optional "only notify if window not focused / session not visible."
- Coalescing so a burst of transitions doesn't spam.

---

## 8. Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Electron app                                             │
│                                                          │
│  Renderer (React + xterm.js)      Main process (Node)    │
│  ─ Roster / cards UI              ─ Session manager      │
│  ─ Embedded terminals    ◀─IPC─▶  ─ PTY host (node-pty)  │
│  ─ Tray popover UI                ─ State detection eng. │
│  ─ Character animations           ─ Persistence (SQLite) │
│                                   ─ Tray + notifications │
└──────────────────────────────────────────────────────────┘
        owns/reads/writes ▼ PTYs
   [ claude code ]  [ copilot cli ]  [ custom cmd ] …
```

- **Main process (Node/TypeScript):** spawns/owns PTYs via **node-pty**, runs the **state detection engine** on each output stream, manages the **Tray** icon/badge and native **Notifications**, and persists state.
- **Renderer (React + TypeScript):** roster UI, session cards, character animations, and one **xterm.js** instance per session bound to its PTY. Terminal I/O is proxied over IPC (write keystrokes → PTY; PTY output → xterm + detector).
- **IPC contract:** `session.create/close/restart`, `session.input`, `session.output` (stream), `session.state` (state updates), `session.rename`, `session.setCharacter`, `roster.get`, `settings.*`.
- **Persistence:** local **SQLite** (`better-sqlite3`) — labels, character assignments, presets, settings, optional event log. Terminal scrollback need not persist (MVP).
- **Menu-bar:** Electron `Tray` (optionally the `menubar` helper) for the popover-from-tray behavior.

### Alternative considered: Tauri (Rust core)
Lighter binaries and lower memory, but the PTY host + detection engine are easiest in Node (mature `node-pty`, `xterm.js` addons) and match Alex's TypeScript stack. **Recommendation: Electron for v1**; revisit Tauri if footprint matters.

---

## 9. Data model

```
Session
  id            (uuid)
  label         (text, user-editable)
  character_id  (fk → character roster)
  preset_id     (fk, nullable)
  command       (text)         # resolved argv
  cwd           (text)
  env_overrides (json, optional)
  status        (active | exited | error)
  state         (STARTING | WORKING | WAITING_INPUT | WAITING_APPROVAL | IDLE | EXITED | ERROR)
  pid           (int, nullable)
  exit_code     (int, nullable)
  created_at, state_changed_at (timestamps)

Preset
  id, name, command_template, default_cwd, default_label_pattern,
  prompt_regex, approval_regex, spinner_charset, t_quiet_ms, t_confirm_ms

CharacterAssignment (or folded into Session)
  identity_key (preset_id + cwd)  → character_id, last_label   # for stable re-assignment

Setting        key → value        # notifications, sounds, sort order, theme, launch-at-login
Event (optional)  session_id, ts, from_state, to_state, note   # for a future activity timeline
```

Ship built-in presets for **Claude Code** and **Copilot CLI** (best-guess regex/timers, then calibrated).

---

## 10. Settings / preferences
- Notifications: on/off, sound, "only when unfocused/hidden," approval-vs-input separately.
- Detection tuning per preset (advanced): timers + regexes.
- Roster sort default (needs-you-first / recent / manual) and density.
- Appearance: theme, character art pack, animation on/off (accessibility).
- Behavior: launch at login, default shell/env, confirm-before-close-with-running-session.

---

## 11. Security & privacy
- **Local-only.** No network calls; session content (your code, prompts, output) never leaves the machine.
- Crew inherits the user's environment to launch agents; **do not log secrets** — event log stores state transitions, never raw output or env values.
- Persist minimal data (labels, presets, character map). Terminal scrollback stays in memory unless a future opt-in "session transcript" feature is added (§14), which must be explicit and local.
- Respect API keys/tokens already in the environment; never copy them into Crew's store.

---

## 12. Accessibility
- Never rely on color alone: pair every dot with an icon/text ("waiting", "working") and shape.
- Respect "reduce motion" (freeze character animation → static pose + dot).
- Full keyboard nav: jump-to-next-waiting, quick-switch palette, rename, new session.
- VoiceOver labels on cards ("PPT agent, waiting for input, 2 minutes").

---

## 13. MVP scope & phased roadmap

### MVP (v0.1) — "see who needs me"
- Launch owned sessions: Claude Code / Copilot CLI / custom command + cwd (+ optional initial prompt).
- Embedded xterm terminal per session (full interaction in-app).
- State detection: `WORKING` vs `WAITING_INPUT` via quiescence + spinner + prompt-regex, debounced. (`WAITING_APPROVAL` best-effort.)
- Per-session **unique character** + **editable label**, persisted.
- Menu-bar **red-dot + count**; tray popover roster with Jump.
- Native notification on `→ WAITING_INPUT`.
- SQLite persistence; sort needs-you-first.

### v1.1 — polish
- Character art pass + full animation set; character picker; stable identity re-assignment.
- `WAITING_APPROVAL` (amber) as a first-class state; approval regexes per preset.
- Sound alerts; notification coalescing/focus rules.
- Keyboard quick-switch + cycle-through-waiting; reorder/rename UX.
- Restart/duplicate session; graceful exit/error handling.

### v1.2 — power features
- Per-preset detection tuning UI; import/export presets.
- Tags/groups (e.g., group by project); filters.
- Activity timeline (from event log): how long each session sat waiting.
- Optional `crew-hook` shim for exact semantic state on cooperating agents.

### v2 — stretch
- Observe **external** sessions (tmux integration) in addition to owned ones.
- Remote sessions over SSH; multi-machine roster.
- Session transcript capture + search (opt-in, local).
- Cross-platform (Linux/Windows) hardening.
- Broadcast input to multiple sessions; templated multi-launch.

---

## 14. Success metrics
- **Time-to-notice** a waiting session drops to near-zero (notification/badge vs manual scanning).
- **Idle-wait time** (agent waiting but unnoticed) trends down.
- Detection **accuracy**: low false-"waiting" (flicker) and low missed-"waiting" on Claude Code + Copilot CLI.
- Alex actually keeps it running daily with 2–6 sessions.

---

## 15. Risks
- **Detection brittleness** across agents/versions (prompt UIs change). → Mitigate with per-preset config + optional `crew-hook`; calibrate on real transcripts.
- **Flicker** between token bursts misread as waiting. → Hysteresis/debounce; require prompt match.
- **PTY/rendering fidelity** (TUIs, colors, resizing). → Lean on mature node-pty + xterm.js; test resize + full-screen TUIs.
- **Electron footprint** with many terminals. → Cap scrollback, virtualize off-screen terminals; revisit Tauri if needed.

---

## 16. Open questions (need Alex's input before/along build)
1. **Which agents first?** Confirm Claude Code + Copilot CLI as the two seed presets, plus any others (aider? plain shells?).
2. **Prompt/spinner signatures:** OK to capture a few real transcripts to lock default regexes/timers?
3. **Character art:** custom-designed set, an open sprite pack, or emoji/glyph fallback for MVP?
4. **Interaction model:** is the **embedded terminal** enough, or do you also want a "pop out to iTerm/Terminal.app" option?
5. **Approval state:** treat `WAITING_APPROVAL` distinctly (amber) from `WAITING_INPUT` (red), or collapse into one "needs you"?
6. **Scale:** typical concurrent sessions (affects layout + perf targets)?
7. **Launch-at-login / persistence:** should Crew relaunch last session set on open, or always start empty?

## Naming
*Crew* (a crew of character-agents) is a placeholder. Alternatives to react to: **Roster**, **Runners**, **Watchtower**, **Herd**, **Relay**, **Pit Crew**. Easy to rename later.

---

### Appendix A — glanceable status logic (pseudo)
```
globalTray =
  count(WAITING_INPUT) + count(WAITING_APPROVAL) > 0 ? redBadge(count, amberIfOnlyApprovals)
  : any(WORKING)                                     ? busyGlyph
  :                                                    neutral

onSessionStateChange(s, from, to):
  updateCard(s); updateTray()
  if to in {WAITING_INPUT, WAITING_APPROVAL} and from == WORKING:
      notify(s.character + " " + s.label + " needs your input")
```

---

## 17. Implementation notes (v0.1 — as built)

Deviations from the spec above that were made pragmatically for the first cut:

- **Persistence:** local JSON file in `userData` (session list, character/label
  assignments, settings, recent dirs) instead of SQLite — avoids a native
  `better-sqlite3` rebuild per Electron ABI for the small amount of data v0.1
  persists. See `src/main/store.ts`.
- **Session resume:** the active session set (agent, cwd, label, character) is
  saved on every structural change and **auto-relaunched on startup** so you
  don't lose your workspace when you quit. A live agent process can't be frozen,
  so each session is re-spawned fresh (same folder/agent/label/character); the
  agent's own conversation history isn't restored (a future `--continue`-style
  hook could add that). Answers SPEC §16 open question 7 (relaunch, don't start empty).
- **Tray:** glanceable status via the menu-bar **title badge** (`🔴 N` / `🟠 N` /
  `🟢`) plus a **context menu** with jump-to-waiting, rather than a custom
  popover window. Functionally complete; a richer popover is a later upgrade.
- **Detection:** quiescence + prompt/approval regex + a debounced (`confirmMs`)
  silence fallback, with two guards against false red dots — an *awaiting-output*
  flag and a post-input **grace window** (`inputGraceMs`) so terminal echo +
  think-time right after your prompt isn't misread as "waiting". Spinner glyphs
  are recognized (keep WORKING). Prompt-regex **calibration** against real Claude
  Code / Copilot CLI transcripts (§16) is still the highest-value follow-up;
  today the two AI presets lean on the silence fallback.
- **Settings UI:** not yet built; defaults live in `store.ts` (notifications,
  sound, notify-only-when-unfocused, sort).

### Verified commands
- `npm run typecheck` — type-check main / preload / renderer
- `npm test` — unit tests for the detection engine (`test/detection.test.ts`)
- `npm run build` — production build via electron-vite
- `npm run rebuild:native` — rebuild `node-pty` for the current Electron ABI (once after install)
- `npm run test:e2e` — Playwright-driven end-to-end run against the built app
- `npm run dev` — run in development

