# Changelog

All notable changes to Crew are documented here. Crew is a macOS menu-bar app for
running and supervising multiple AI CLI agent sessions at a glance.

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
