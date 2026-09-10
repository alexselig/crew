# Changelog

All notable changes to Crew are documented here. Crew is a macOS menu-bar app for
running and supervising multiple AI CLI agent sessions at a glance.

## 0.5.14 — 2026-09-10

### Added
- **Agents can be opened and read from the shelf.** Hovering an agent in the
  Agents shelf now reveals a pencil; clicking it opens that agent so you can
  read its prompt and edit it, instead of only being able to run it. Built-in
  agents were previously read-only in the editor with every field greyed out —
  their fields are now editable and saving forks them into your own copy, so
  the shipped agent is still preserved.

### Changed
- **Agent names are sized like session names.** They were 12.5px against the
  roster's 16px, which made a specialist read as a footnote rather than a peer
  of the sessions above it.
- **The transcript parser ignores the `model.*` event family.** An undeclared
  internal trace added in CLI 1.0.81-8; `model.messages_snapshot` repeats the
  entire conversation on one line, so skipping it early is free speed.

### Fixed
- **A failed tool run shows what went wrong again.** Copilot CLI puts a failure's
  message in a sibling `error` field, not in `result` — Crew only read `result`,
  so every failed run rendered as a red block with nothing in it. In one real
  session on this machine that was 214 of 1,795 runs, silently blank: precisely
  the runs worth reading. Now 0.
- **Edits render as a diff, not a wall of file.** A tool result carries both the
  model-facing `content` and a `detailedContent` meant for display; for an edit
  the first is the entire new file and the second is the diff. Crew showed the
  former. 371 blocks in one session were a full-file dump where a diff belonged.
- **A corrupt line no longer takes the rest of the transcript with it.** Copilot
  CLI opens, appends and closes the log per event with no serialisation, so
  records get concatenated onto one line, cut in half, or written with raw
  unescaped newlines (copilot-cli#4098, #2649, #2012). Crew parsed strictly per
  line and dropped whatever it could not read — including, sometimes, the good
  event that followed. It now recovers concatenated and split records, repairs
  raw control characters, and confines an unreadable record to itself.
- **A standing approval reads as "always" instead of "once".** The resolution was
  matched against the word "always", which the CLI never writes — its vocabulary
  is `approved-for-location`. Every session-wide grant was mislabelled.
- **A chunked answer is one message again.** Long replies can arrive split across
  records sharing a `messageId`; they were drawn as a run of fragments.
- **Briefs are refreshed for the sessions you actually use.** `handoff.mjs` ranked
  and filtered on `sessions.updated_at`, which Copilot CLI writes once at
  creation and never bumps (copilot-cli#2192, open since March, reproduced here:
  26 of 26 recent sessions stale, one by 13 days). `--days 7` found 9 sessions
  where it should have found 14 — and the 5 it skipped included the two most
  active on the machine. Recency now comes from the newest turn. Sessions whose
  `cwd` the CLI left NULL (copilot-cli#2655) are no longer dropped either.
- **A handoff keeps its original conversation link across every restart.** A
  fresh successor previously retained the old conversation for one launch, then
  discarded that lineage on the next asleep restore. Saved sets dropped it too.
  Crew now persists both the current agent session and its handoff source until
  a later conversation genuinely supersedes it.
- **Refreshing one handoff no longer deletes all the others.** The documented
  single-session and `--days` commands built a partial result, then treated it
  as the complete roster and removed every brief outside that scope. Cleanup and
  index replacement now run only for an unfiltered full rebuild.
- **Built-in agents are protected below the UI.** Saving edits still forks a
  built-in into a custom agent, and now the shared persistence path also refuses
  to overwrite or delete the shipped original.

## 0.5.13 — 2026-08-26

### Added
- **Restored context now adapts to the length of the conversation.** A new
  "Auto" mode — the default — replays the whole transcript while a session's
  history is short and only falls back to the summary once it has genuinely
  outgrown the context window (2 MB of agent log; the median session is 0.1 MB,
  so nearly everything comes back in full). Transcript and Brief remain
  available if you want the old all-or-nothing behaviour. Stores set to Brief
  are moved to Auto once, because always-Brief was costing short sessions their
  real history too.

### Changed
- **Handoff briefs carry far more of the conversation.** They were built from a
  single checkpoint field and the user's half of the last six exchanges. They now
  reproduce every checkpoint field Copilot writes — what was done, technical
  details, key files, next steps and how the work got here — and quote both sides
  of the closing exchanges, weighted so the newest turns are near-verbatim.
  Typical brief: ~930 tokens, up from ~370; the richest ~9.5k, against hundreds
  of thousands for a replay.
- **Trimmed the workspace-filter notice back to the count.** The sidebar no
  longer carries a "Show all sessions" button or a line about hidden sessions —
  the header count reading "1 OF 100" is enough to show a filter is on, and the
  ✕ on the workspace chip and File ▸ Change Workspace ▸ All Sessions already
  turn it off.

## 0.5.11 — 2026-08-26

### Fixed
- **A workspace filter could hide 99 of your 100 sessions without saying so.**
  The sidebar simply read "1 SESSION" — a roster that looks present, just wrong,
  which is the one case the empty-state message never covered. The count now
  reads "1 OF 100" whenever a workspace is filtering, and the sidebar says how
  many sessions that workspace is hiding, with one click to show them all.

## 0.5.10 — 2026-08-26

### Fixed
- **"No sessions yet" when a workspace filter was hiding all of them.** With a
  workspace open that contained none of your sessions, the sidebar reported an
  empty roster — indistinguishable from Crew having lost your work. It now names
  the workspace responsible and offers a "Show all sessions" way out.
- **Resuming a saved set appeared to do nothing.** Resumed sessions joined no
  workspace, so under an active filter they landed somewhere you weren't looking:
  the click worked, the sessions were real, and none of them were on screen. A
  resumed set now joins the workspace you're viewing, exactly as a new session
  does.
- **Resuming a set no longer boots every agent at once.** A set can be dozens of
  sessions; starting them together was the same storm that restoring a roster
  used to cause. Sets now come back asleep and start as you open them.

## 0.5.9 — 2026-08-26

### Fixed
- **The flicker: a workspace with nothing in it made Crew fight itself until it
  ran out of memory.** Which session is selected was decided in two places at
  once — one restored a selection from your whole roster whenever none was set,
  the other cleared any selection the workspace filter hid. If the workspace you
  had open contained none of your sessions, neither could ever be satisfied, so
  they undid each other as fast as the app could redraw. The window pinned a CPU
  core, stopped responding, and after a few minutes exhausted its memory and was
  restarted — which repaints everything, and is exactly what the flickering was.
  Selecting a session is now decided in one place, by one rule: it is always a
  session you can actually see. An empty workspace now simply says so.
- **Sessions no longer all restart at once when Crew opens.** Reviving a whole
  roster meant every agent booting and replaying its conversation simultaneously.
  Your sessions now come back instantly — every one of them, in the right group,
  with its label and character — and each agent starts when you open or type into
  that session. Launch is immediate whatever the size of your roster, and idle
  sessions cost nothing.
- **Output from a busy agent no longer arrives one keystroke at a time.** A
  terminal can produce output far faster than it can be drawn, and every burst
  was being sent to the display the instant it arrived. Output is now gathered
  per session and delivered 25 times a second. A single session that floods is
  capped, keeping the newest output and marking in the transcript that earlier
  output was trimmed.

### Added
- A diagnostic memory census, off unless `CREW_MEMLOG=1` is set, recording what
  the window is holding to `crew-crash.log`. When a display runs out of memory
  there is nothing left to inspect afterwards, and remote debugging is blocked on
  some machines.

## 0.5.8 — 2026-08-26

### Fixed
- **A grid of sessions gave every tile its own terminal emulator.** 0.5.7 bounded
  the pool but exempted terminals that were on screen, and the grid mounts one
  per tile — so on a large roster the cap never applied and the renderer still
  climbed past 5 GB at 500% CPU. Tiles now mount a real emulator only when they
  are at the viewport; the rest show the last lines of output as inert text. The
  session keeps running and its output keeps accruing — only the emulator is
  withheld, and it appears as soon as the tile scrolls into view.

## 0.5.7 — 2026-08-26

### Fixed
- **The flicker: the renderer was running out of memory and being restarted.**
  Crew pooled one live terminal emulator per session and never released it. That
  is fine for a handful of sessions, but agent sessions stream output even when
  idle — spinners, progress bars, TUI repaints — so on a large roster dozens of
  emulators kept parsing and buffering output for panes nobody was watching. The
  renderer climbed past 4.7 GB and Blink aborted it with `Oilpan: Large
  allocation ... out of memory`; each rebuild of the dead renderer repainted the
  entire window, which is what the flicker was. It got worse the longer Crew ran
  and cleared on restart, exactly as reported.

  Both terminal pools are now bounded. Past the cap a session goes *dormant*: it
  keeps its OSC parse state, semantic blocks, typed transcript and a 64 KB tail
  of recent output, but owns no emulator until you open it, at which point the
  tail is replayed so it opens with context rather than a blank screen. Nothing
  is dropped and no history restarts — only scrollback older than the tail is
  lost for sessions you never looked at. Retirement is by least-recently-*viewed*
  (never by output, or a noisy background session would outrank the one you just
  left), and a terminal that is on screen is never retired.
- **Inline-image storage was unbounded per terminal.** The image addon reserves
  128 MB of decoded bitmaps by default, for every terminal; now 8 MB, which still
  comfortably holds the plots and screenshots agents actually emit.

## 0.5.6 — 2026-08-26

### Fixed
- **Batched restore could prune the roster it was still restoring.** 0.5.5 began
  re-launching saved sessions in batches, but `persistSessions()` saves the live
  session map — and a queued session isn't in it yet. Because a save fires on
  nearly every event, a 63-session roster was rewritten to 16 within seconds of
  launch, deleting the rest permanently. Queued sessions are now persisted
  alongside live ones until they spawn, closing a session that hasn't spawned
  yet removes it from the queue instead of resurrecting it on the next save, and
  a quit mid-restore keeps the whole roster.

## 0.5.5 — 2026-08-26

### Fixed
- **Window-wide flicker on startup with a large roster: every saved session was
  re-launched in one tick.** `restore()` spawned a PTY for every persisted
  session in a single synchronous loop. Each one immediately streams its agent's
  boot output into its own terminal engine, so a 63-session roster put 63
  terminals' worth of output on the renderer in the same frame — measured at
  534% CPU and 4.9 GB resident, which flickers the whole window until it catches
  up. This is why the flicker got worse as the roster grew. Crew now restores in
  batches of 4 with a short gap, returning the first batch immediately and
  filling the rest in via roster events; queued batches are cancelled on quit so
  shutdown never spawns agents into a closing app, and one session that fails to
  restore no longer strands the ones queued behind it.

## 0.5.4 — 2026-08-26

### Added
- **Dated store snapshots, so a pruned roster is recoverable days later.** The
  roster is the only record of which agent conversation each session maps to,
  and it was protected by nothing but a `.bak`/`.bak2` pair rotated on *every*
  save. Because the store is rewritten on nearly every event, a bug that dropped
  sessions destroyed all three copies within seconds — which is exactly what
  happened to a 63-session roster that came back as 12, with every backup
  already overwritten. Crew now writes a dated snapshot of the roster it loaded,
  at most once a day, keeping the last 14 in `backups/` beside the store. The
  snapshot is taken at startup before anything can overwrite it, and an empty
  roster is never snapshotted — otherwise the damage would spend a retention
  slot that should hold the last good copy.

## 0.5.3 — 2026-08-26

### Fixed
- **Render flicker that got worse the longer Crew ran: WebGL context
  exhaustion.** The enhanced terminal (Settings → Beta Enhanced Terminal
  Interface) took a WebGL context on a terminal's first mount and never gave it
  back. Pooled terminals live for a session's whole lifetime, so the number of
  live contexts grew with every session ever viewed. Chromium caps active WebGL
  contexts per renderer at 16 and **force-loses the oldest** past that — so each
  newly shown terminal knocked out another pane's renderer and made it repaint,
  as a flash somewhere the user wasn't even looking. That is why it worsened as
  a roster was worked through, and why restarting the app cleared it. Crew now
  enforces its own budget of 8 contexts, reclaims them from off-screen terminals
  (invisible — they aren't painting), and leaves a newly shown terminal on the
  DOM renderer rather than evicting a visible one. Releasing a context also
  calls `WEBGL_lose_context`: disposing the addon drops the canvas, but the GL
  context itself lingers until the browser collects it, and Chromium counts
  those against the cap — so a burst of mounts (opening grid view over a big
  roster) could still overshoot. A GPU-initiated context loss now returns its
  slot to the budget instead of leaking it.

  Verified end-to-end in a real renderer (`test/e2e/webgl-budget.verify.mjs`):
  walking a 24-session roster made Chromium force-lose a context **8 times**
  before the fix, and **0 times** after.
- **Flicker / unusable window: process-table exhaustion.** `resolveGithubUrl`
  shelled out to `git remote get-url origin` on every call, and `GithubButton`
  re-resolves on every mount *and* every `window.focus`. Across a restored
  roster this reached ~2,000 concurrent `git` processes and hit the per-user
  limit (`kern.maxprocperuid`), so new spawns failed with
  `fork: Resource temporarily unavailable`. Measured 772 -> 5,496 processes in
  40 seconds. Remotes are now memoised with a 30s TTL and concurrent callers
  are de-duplicated onto a single in-flight lookup, so a burst of 200 callers
  performs exactly one spawn.

## 0.5.2 — 2026-08-26

**Sessions too large to replay can now come back.**

### Added — handoff briefs and "brief" restored-context mode
- Resuming replays the whole `events.jsonl`. A 0.5 MB history costs well over a
  million tokens, and a multi-megabyte one exceeds any context window — so a
  long-running session quietly becomes unresumable, however healthy it looks.
- `npm run handoff` rebuilds every session into a ~1–2k token brief under
  `~/.crew/handoffs`, from data Copilot already keeps on disk: its own
  compaction checkpoints, the files touched, the commits made, and the user's
  last instructions. Reading the local session store costs **no tokens**.
- New **Settings → Restored context**. *Transcript* is the old behaviour.
  *Brief* starts a fresh conversation and types in a pointer to that session's
  brief instead — the only way an oversized session returns at all, and it
  leaves the context window free for actual work.
- The primer is typed but **never submitted**, so restoring a large roster costs
  nothing until you engage with a session.
- `scripts/com.crew.handoff.plist` keeps briefs fresh on a 30-minute timer.

### Fixed — a relaunch could orphan a conversation
- Turning conversation resume off dropped the stored `agentSessionId`, and the
  next save overwrote it with a freshly minted one — silently cutting the link
  to a real conversation that still existed on disk.
- A known conversation id is now always preserved: as `agentSessionId` when
  reattaching, or as `priorSessionId` when a fresh agent supersedes it. A
  transcript can no longer be orphaned by relaunching.

## 0.5.1 — 2026-08-25

**Fix: a crashing agent could permanently delete its own session.**

### Fixed — session loss when agents die
- Crew saved only sessions that were still **active**, and it re-saved on every
  process exit. So when an agent died, its session was erased from the saved
  roster — permanently, with no way back.
- This turned a passing outage into real data loss. An expired MCP OAuth token
  started returning 401 to every Copilot launch; each restored agent died on
  startup, and each death rewrote the roster without it. A 46-session roster
  shrank to 12 over a few relaunches, and the spawn/die/respawn churn showed up
  as a flickering window.
- Status is temporary; being on the roster is not. Crew now saves every session
  it's tracking, whatever state it's in. Closing a session still removes it — 
  that path was always separate.

### Fixed — the roster is now backed up
- `crew-store.json` is the only record of which conversation each session belongs
  to, and it's rewritten constantly. It now rotates to `.bak` and `.bak2` on each
  save.
- If the file is ever unreadable, Crew recovers from the most recent good backup
  instead of quietly starting with an empty roster.

## 0.5.0 — 2026-08-18

**Manage workspaces, on-call specialist agents, and App-pane fixes.**

### New — Workspace Manager
- Workspaces are now a first-class way to organize your crew at a macro level.
  **File › Workspaces…** (⌘⇧W) opens a full-screen board — one lane per workspace
  plus a pinned **Archived** lane — where you drag sessions between workspaces.
- Dragging **adds** a session to a workspace (it stays wherever it was); hold
  ⌘/⌥ to **move** it, or drop it on **Archived** to remove it from all. It's the
  same live session shown in many places — organizing never starts or stops an
  agent.
- Create / rename / describe / reorder / delete workspaces (deleting archives its
  sessions, never closes them), and give each session an inline **name +
  description**. Under the hood workspaces became first-class entities with a
  one-time migration from the old name-based tags.

### New — Specialist agents
- A shelf of reusable **agents** (UX Critique, Code Review, Security Review, Doc
  Writer…) now sits at the bottom of the nav. Point one at a session and Crew
  runs it **headless/one-shot** in that session's folder and reports back — like
  a skill, but with its own brain — while you keep working.
- A streaming **result panel** lets you **Copy**, **Insert into session**, or
  **Save to Assets** (a markdown note that shows up in the Assets pane; markdown
  is now a previewable asset type). Specialists are **read-first** by default and
  never touch your live session; a write-capable agent is clearly flagged.
- Bring your own: add a custom specialist (name, icon, base model, persona) or
  duplicate a built-in.

### Fixes
- The **App** pane is now purely a viewer of the dev server *you* start in the
  terminal. Removed the "Launch app" button — Crew no longer starts servers for
  you, which also removes a case where launching in a non-web folder could serve
  that directory's file listing.
- The **App** tab now appears only once Crew detects a real local dev-server URL,
  and switching to (or creating) a session with no app no longer strands you in
  an empty App view.
- Minimized-list sessions: the status dot no longer covers the animal mascot.
- Hardening: the built-in static-server path binds to loopback only and requires
  a real `index.html`.

## 0.4.6 — 2026-08-08

**See the app you're building — a new "App" pane.**

- Each session now has an **App** tab next to Terminal/Transcript that renders
  the web app that session is building, live, inside Crew. Crew watches the
  session's output for a local dev-server URL (Vite, Next, CRA, and friends) and
  lights up the tab automatically when it sees one.
- The pane has a thin toolbar — **Reload**, the current URL, **Stop** (for dev
  servers Crew started), and **Open in browser**. If a server isn't running yet
  but the working directory can start one, the pane offers a one-click
  **Launch app**.
- Safe by construction: the embedded view only ever loads a local (loopback)
  dev server — never an arbitrary site — runs with node integration disabled in
  an isolated session, and sends any pop-out links to your default browser.

## 0.4.5 — 2026-07-31

**In-app update notifications.**

- Crew now tells you when a newer signed build is available — a subtle,
  dismissible toast with a one-click **Download**. It checks GitHub Releases in
  the background (shortly after launch, then periodically); dismissing remembers
  that version so it won't nag, while a later release still shows. No more
  manually checking for updates.

## 0.4.4 — 2026-07-30

**A large-input safety warning, reliability fixes, and Activity chart filtering.**

### New — large-input warning
- A maroon footer bar now appears below the terminal when the unsent input for a
  session exceeds a configurable token estimate (default **100,000**;
  Settings ▸ **Large-input warning (tokens)**, 0 = off). It catches the classic
  "paste a big blob to rehydrate a conversation" case before you submit a huge
  send. The terminal shrinks slightly to make room.

### Fixes
- **Stopping a dev server can no longer take the whole app down.** A launcher
  edge case could signal Crew's own process group (killing the app and every
  session) when a spawned dev server had no pid; now guarded.
- **The default terminal no longer throws on every submit.** The legacy engine
  was missing an xterm flag, so pressing Enter raised an internal error and the
  input-row highlight didn't paint. Fixed.
- **Modal buttons stay reachable.** A tall New Session dialog (with "Advanced"
  open) or a short window could push Launch/Cancel off-screen; modals now scroll
  with a pinned action bar.
- **A corrupt settings file is preserved, not overwritten** — it's moved aside to
  a timestamped backup so nothing is silently lost.

### Project Tracker
- The **Activity** chart can now be **filtered by project** (All + per-project).
- Reliability + polish on the tracker's top controls.

### Under the hood
- Trimmed unused webfonts; hardened the transcript poller; expanded automated
  end-to-end coverage across the full session lifecycle.

## 0.4.3 — 2026-07-29

**Project Tracker absorbs Activity & Spend; a refined grid Transcript toggle.**

### Project Tracker
- **Merged Activity & Spend into the tracker.** The separate "Activity & spend"
  dialog is gone; its Spend table and token-usage/commit **Activity** feed now
  live inside the Project Tracker, reached through two top-level sections:
  - **Activity** — Past Week, Spend, and Activity (token usage + recent commits).
  - **Planning** — the live project index (All + per-tag groups) with each
    project's open tasks and proposed next steps.
- **Two toolbar buttons, one feature:** the chart icon deep-links to the tracker's
  **Activity** section and the clipboard icon to its **Planning** section (the
  command palette exposes both as "Activity & spend" and "Project tracker").

### Grid
- The per-tile **Transcript toggle** gets a purpose-built "rail-and-blocks" icon
  (filled bars off the timeline, open rings), with crisper rendering at small sizes.

## 0.4.2 — 2026-07-29

**Transcript view upgrades, plus two UI fixes.**

### Transcript (Beta Enhanced Terminal)
- A **prompt composer** — message the agent directly from the Transcript pane.
- **Thinking blocks** now render with a brain icon and a 2-line clamp with
  show more / less.
- Fixed the inline-image **lightbox** (it never opened — z-index was too low).
- Quieter under the hood: version-token polling replaces idle IPC chatter.

### Fixes
- **Project Tracker:** the masthead controls (Auto / Refresh / ✕) now stay
  pinned for the *entire* scroll — previously the close button could scroll out
  of reach near the bottom of a long list.
- **Activity ▸ Spend:** the "Manual — spend calculated from…" description no
  longer clips the tops of letters.

## 0.4.1 — 2026-07-29

**Token analytics, a two-column Settings, and Project Tracker polish.**

### Activity view — token usage over time
- The Activity tab now charts **token use over time** with a **1h / 24h / 7d /
  30d / 1y** toggle and appropriately-sized buckets (5-minute, hourly, daily,
  daily, monthly).
- A **project-intensity** ranking shows where those tokens went — by git repo,
  falling back to the session — with a headline total, credits (AIU), and the
  peak bucket for the selected range.
- All read-only from your local Copilot CLI history; nothing leaves your machine.

### Project Tracker
- The **Past Week** tab now shows **total tokens** (input + output) per project
  and per session, and ranks the projects strip by token intensity.
- The masthead controls (Auto / Refresh / ✕) are now **pinned while you scroll**,
  so the close button is always reachable.

### Settings
- The settings list now flows into **two columns** in a wider modal (with a
  single-column + scroll fallback on narrow or short windows) so nothing runs
  off the bottom of the screen.

### Refinements
- Clicking a session in the nav now **reveals and selects** it; the stale-hide
  default was raised to 72h.
- Transcript view polish: centered pane toggle, amber user cards, and
  click-to-zoom images.

## 0.4.0 — 2026-07-28

**Beta Enhanced Terminal engine, a typed Transcript view, plus Project Tracker refinements.**

### Enhanced Terminal (Beta)
- A new Crew-owned terminal engine behind **Settings ▸ "Beta: Enhanced Terminal
  Interface"** (off by default, app-wide): GPU (WebGL) rendering, Unicode 11
  widths, and inline images (Sixel / iTerm2). Toggle it off to return to the
  classic terminal instantly.
- **Highlighted input rows** (light-yellow row + amber left bar) for every
  command you run, an **overview-ruler map** in the scrollbar gutter (yellow =
  your prompts, green/red = exit code), and **jump-to-prompt** navigation
  (`⌘↑` / `⌘↓`).
- Optional **zsh / bash shell integration** (OSC 133) for exact per-command
  marks. Highlights are purely visual — they never intercept clicks, text
  selection, or scrolling.

### Transcript view
- A typed, block-based **read layer** over a session — user / agent / thinking /
  tool run / diff / plan / decision / permission / error / image — on the
  Obsidian hairline rail. Switch **Terminal ⇄ Transcript** from the session
  header; the raw terminal stays the source of truth.

### Session spend
- Per-session cost gains an **Auto / Manual** mode.

### Project Tracker
- **Rebuilt each project card around three clearer bands.** A promoted
  **Recently shipped** band (a one-line "what's been checked in" summary — commits
  this week, unpushed/uncommitted, clean-tree state — plus the latest commits
  inline) now answers "what did I ship" at a glance, instead of hiding history
  behind a collapse.
- **"Open tasks" are now only real, verifiable work** — the agent's live session
  todos plus items from dedicated task files (TODO/STATUS/ROADMAP…). The old
  scrape of bullets from *any* README/SPEC prose is gone, so tasks no longer look
  fake. The section (and the "N open" pill / Open-tasks stat) only appears when
  tasks actually exist — no empty-state filler.
- **New "Proposed next steps"** — a few clearly-labelled, repo-signal-derived
  suggestions (commit/push, add tests, add a remote, deploy, tag a release,
  resolve TODO/FIXME markers, revisit if stale…), shown secondary to and separate
  from real tasks so they never masquerade as one.
- Masthead swaps the low-signal **Groups** count for **Shipped · 7d**; the row
  pill surfaces uncommitted work when a project has no open tasks.

## 0.3.1 — 2026-07-24

**Windows support, Intel Mac support, plus tracker and terminal refinements.**

### macOS — now Intel too
- In addition to Apple Silicon, Crew now ships a **native Intel (x86_64)** build
  for Intel Macs (e.g. 2018–2020 models). Both are Developer ID **signed +
  notarized**. Download `Crew-AppleSilicon.zip` or `Crew-Intel.zip` (the site
  links both) — unzip and drag Crew to Applications.

### Windows
- Crew now runs on **Windows** (x64). Sessions spawn PowerShell, the tray shows a
  visible icon with a status tooltip, the window uses a native frame, and paths
  resolve from your user profile. Shipped as an **NSIS installer + portable zip**,
  built in CI on a Windows runner. Windows builds are **unsigned for now**, so
  SmartScreen shows a "More info → Run anyway" prompt until code signing lands.

### Project Tracker
- Pulls each project's **live tasks from its agent session's todo list**, in
  addition to TODO/STATUS/ROADMAP files.
- **Removed the canned "Suggestions."** The tracker now shows only tasks it
  actually finds — with a clear empty state when there are none — instead of
  repeating generic advice across every project.

### Sessions
- **Links in the terminal open in your default browser** instead of a new in-app
  window.
- **Left/Right arrows edit the prompt** when a terminal is focused (rather than
  paging the grid).
- The **Skills** floaty is back on grid-view session tiles, and the skills picker
  **color-codes skills by how often you use them** (heat dots + legend).
- Nav cards use an on-brand focus ring instead of the native macOS one.

### Notes
- macOS builds remain **signed with Developer ID and notarized by Apple**.
- Windows code signing (Azure Trusted Signing) is planned for a future release.

## 0.3.0 — 2026-07-21

**The mission-control dashboard.** This milestone turns Crew from a session
switcher into a live command center for everything you're building.

### Installing — signed & notarized
- Releases are now **signed with Developer ID and notarized by Apple** (and
  stapled), so downloads open with **no Gatekeeper warning** and are not removed by
  Microsoft Defender on managed Macs.
- One-command installer: `curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash`.
- Signing/notarization is reproducible via `scripts/sign-notarize.sh`; see
  `MACOS-SIGNING.md`.

### Project Tracker
- A full-screen **Project Index** that indexes the working directories of your
  open sessions, derived live from disk on every open — no database, nothing to
  sync.
- Per project: recency **status** dot, **version** (package.json → git tag →
  commit count), framework, branch, commit count, uncommitted/ahead, **GitHub**
  and **live** links, **next steps** parsed from your TODO/STATUS/ROADMAP files
  (source-tagged), up to 5 priority-ranked **suggestions**, and a collapsible
  **commit + CHANGELOG history**. The "N open" pill is your open-task count.
- **Launch local** — start a project's dev server on a free port and open the
  localhost link right from the card (with Stop / external-server adoption).
- Editorial design: bundled Instrument Serif + Space Grotesk, espresso/cream/gold
  theme, an Auto/Refresh masthead, and section blurbs — grouped by your session
  tags. Launch it from the clipboard icon in the nav toolbar or the grid title
  bar; projects with open tasks expand by default.

### Activity & spend
- Split into two tabs — **Spend** (per-session waiting time, cost, credits) and
  **Activity**, which shows your recent **git commits** (with messages; releases
  highlighted) instead of low-signal state churn. Commit data is cached and
  revalidated by HEAD so re-opening doesn't re-scan git.

### Sessions & navigation
- **Focus is never lost on re-bucketing:** prompting an idle session (which jumps
  it to a fresher recency bucket) or re-tagging it now keeps that session
  scrolled into view, in both the grid and the nav.
- **Restore on open:** selecting a minimized session — in the nav *or* by
  clicking/expanding its grid tile — un-minimizes it instead of leaving it hidden
  behind "show more".
- Cleaner grid "show more" (line-art mascots, no circular chips) and a new
  clipboard-check tracker icon.

## Earlier (0.2.x highlights)

- **0.2.39** — Project Tracker rebuilt to match the design spec (bundled fonts,
  full data model, Launch-local); Activity feed shows commits only.
- **0.2.38** — Rich live Project Tracker detail; Activity/Spend tabs; commit cache.
- **0.2.36** — First Project Tracker; restore a minimized session from the nav;
  Activity & spend modal scrolls instead of running off-screen; straight nav drag
  drop-line.
- **0.2.35** — Categorized/searchable Skills picker; grid "show more" card; group
  ordering fix; command-palette icons; live HTML asset thumbnails.
- **0.2.3x** — New Session dialog polish; always-default workspace with a Change
  link; chip restyle; per-bucket "show more" with minimize.
