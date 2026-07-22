# Changelog

All notable changes to Crew are documented here. Crew is a macOS menu-bar app for
running and supervising multiple AI CLI agent sessions at a glance.

## 0.3.0 — 2026-07-21

**The mission-control dashboard.** This milestone turns Crew from a session
switcher into a live command center for everything you're building.

### Installing (no Gatekeeper "malware" warning)
- New one-command installer: `curl -fsSL https://github.com/alexselig/crew/releases/latest/download/install.sh | bash`.
  It downloads with `curl` (which sets no `com.apple.quarantine` flag) and strips
  quarantine, so the un-notarized app installs and launches cleanly instead of
  being blocked as "malware". See `MACOS-SIGNING.md` for the details and the path
  to a fully notarized build.

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
