// Types for the Project Tracker: a live, editorial "Project Index" derived from
// disk (git, package.json, task files) for the working directories of the
// currently open sessions. Populated by src/main/tracker.ts, rendered by
// src/renderer/components/ProjectTracker.tsx.

import type { SessionState } from './types'

/** Recency/health of a project, driving its status dot color. */
export type ProjectStatus = 'active' | 'recent' | 'stale' | 'spec' | 'unknown'

/** Which GitHub account owns the repo (from the origin remote). */
export type ProjectOrigin = 'work' | 'personal' | 'external'

export interface TrackerNextStep {
  text: string
  /** File the step was parsed from (e.g. STATUS.md). */
  source: string
}

export interface TrackerCommit {
  sha: string
  subject: string
  when: string | null
  /** Looks like a release/version/changelog commit → highlighted. */
  isRelease: boolean
}

export interface TrackerChangelog {
  version: string
  items: string[]
}

/** A currently-open Crew session contributing to a project. */
export interface TrackerSessionRef {
  id: string
  label: string
  state: SessionState
}

export interface TrackerProject {
  /** Absolute working directory (the project's identity). */
  cwd: string
  /** Display path, e.g. `~/crew`. */
  dir: string
  name: string
  tag: string
  /** Identity color from the session. */
  color: string
  origin: ProjectOrigin | null
  github: string | null
  live: string | null
  version: string
  framework: string | null
  branch: string | null
  status: ProjectStatus
  commitCount: number
  lastCommitWhen: string | null
  uncommitted: number
  ahead: number
  /** Most recent session activity (max lastPromptAt/createdAt), ms epoch. */
  lastActive: number
  lastActiveWhen: string | null
  /** Number of open (active) sessions in this project. */
  openSessions: number
  sessions: TrackerSessionRef[]
  nextSteps: TrackerNextStep[]
  suggestions: string[]
  commits: TrackerCommit[]
  changelog: TrackerChangelog[]
}

export interface TrackerGroup {
  tag: string
  label: string
  blurb: string
  projects: TrackerProject[]
}

export interface TrackerData {
  generatedAt: string
  totals: {
    projects: number
    groups: number
    /** Sum of open next-step items across projects. */
    openTasks: number
    /** Projects that are git repos. */
    repos: number
    /** Open sessions represented. */
    sessions: number
  }
  groups: TrackerGroup[]
}

/** Input passed from the renderer's roster into the main-process scan. */
export interface TrackerSessionInput {
  cwd: string
  tag: string
  color: string
  label: string
  lastActive: number
  sessions: TrackerSessionRef[]
}
