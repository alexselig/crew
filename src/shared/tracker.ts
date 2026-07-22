// Project Tracker data model — matches the handoff contract exactly
// (~/project-tracker/handoff/types.d.ts, tracker v0.1.0). Built by
// src/main/tracker.ts, rendered by src/renderer/components/ProjectTracker.tsx.
//
// Scope note for the Crew integration: the tracker indexes the working
// directories of the currently OPEN sessions only (one project per session).
// The standalone tool's synthetic "Other repos" walk is intentionally omitted.

export type ProjectStatus =
  | 'active' // git commit within 7 days
  | 'recent' // within 30 days
  | 'stale' // older than 30 days
  | 'spec' // docs/markdown only, no code detected
  | 'unknown' // folder found but no git history
  | 'no-folder' // session points at a folder that doesn't exist

export type Framework = 'next' | 'vite' | 'electron' | 'node' | 'static' | null
export type Origin = 'work' | 'personal' | 'external' | null
export type ProjectKind = 'session' | 'repo'
export type VersionSource = 'package.json' | 'git tag' | 'git' | null

export interface Commit {
  sha: string
  subject: string
  date: string | null
  when: string | null
  author: string | null
  isRelease: boolean
}

export interface NextStep {
  text: string
  source: string
}

export interface ChangelogSection {
  version: string
  items: string[]
}

export interface Stats {
  commitCount: number
  lastCommitWhen: string | null
  lastCommitIso: string | null
  daysSinceCommit: number | null
  uncommitted: number
  ahead: number
  hasTests: boolean
  isGit: boolean
  framework: Framework
}

export interface Launch {
  framework: Framework
  launchable: boolean
  opensUrl: boolean
  cmdPreview: string | null
}

export interface Project {
  id: string
  kind: ProjectKind
  label: string
  tag: string
  color: string
  character: string | null
  createdAt: number | null
  lastActive: number | null
  lastActiveWhen: string | null
  dir: string | null
  note: string | null
  found: boolean
  origin: Origin
  github: string | null
  live: string | null
  version: string
  versionSource: VersionSource
  pkgName: string | null
  branch: string | null
  commits: Commit[]
  changelog: ChangelogSection[]
  nextSteps: NextStep[]
  stats: Stats | null
  launch: Launch
  status: ProjectStatus
}

export interface Group {
  tag: string
  label: string
  blurb: string
  projects: Project[]
}

export interface Totals {
  projects: number
  sessions: number
  repos: number
  found: number
  groups: number
  openTasks: number
}

export interface TrackerData {
  generatedAt: string
  totals: Totals
  groups: Group[]
}

// ── Launcher runtime status (matches types.d.ts) ────────────────────────────

export interface RunningServer {
  id: string
  label: string
  port: number | null
  url: string | null
  framework: Framework
  status: 'starting' | 'running' | 'exited'
  startedAt: number
  pid: number
  external?: boolean
}

export interface LaunchResult {
  ok: boolean
  id?: string
  label?: string
  port?: number | null
  url?: string | null
  framework?: Framework
  status?: string
  pid?: number
  external?: boolean
  already?: boolean
  slow?: boolean
  note?: string
  error?: string
  log?: string
}

// ── Internal (not part of the /api/data contract) ───────────────────────────

/** One open Crew session handed to the scan (the tracker's project source). */
export interface TrackerSessionInput {
  id: string
  label: string
  tag: string
  color: string
  character: string | null
  createdAt: number | null
  lastPromptAt: number | null
  /** Absolute working directory of the session. */
  cwd: string
  /** The agent's own session UUID — locates its live todo list on disk. */
  agentSessionId: string | null
}

/** A git commit surfaced in the analytics Activity feed. */
export interface CommitActivity {
  cwd: string
  project: string
  sha: string
  subject: string
  ts: number
  isRelease: boolean
}
