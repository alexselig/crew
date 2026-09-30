// The runtime factory: turns a persisted ConductorConfig into the live
// ConductorRuntime that conductor-ipc.ts's shipped backend needs. This file
// contains the only place that derives Conductor's on-disk scratch paths, so
// that guarantee (Conductor never writes into the user's repo) lives in one
// auditable spot rather than being re-derived ad hoc wherever a workspace is
// wired up.

import { join, resolve, sep } from 'node:path'
import { createLaneManager } from './lanes'
import { createJournal } from './conductor-journal'
import { createConductor } from './conductor'
import type { ComposeDeps } from './conductor-compose'
import type { ConductorRuntime } from './conductor-ipc'
import type { ConductorConfig, ConductorSettings } from '../shared/conductor'

/** Thrown by conductorPaths() when workspaceId cannot be proven safe to use
 *  as a single path segment under <userDataDir>/conductor/. Fail-closed:
 *  anything that cannot be proven safe is rejected, never sanitised, because
 *  a sanitised id could silently collide with another workspace's directory
 *  (e.g. "a/b" and "a..b" both being stripped to "ab"). */
export class InvalidWorkspaceIdError extends Error {
  constructor(workspaceId: unknown) {
    super(`invalid conductor workspaceId: ${JSON.stringify(workspaceId)}`)
    this.name = 'InvalidWorkspaceIdError'
  }
}

// A workspaceId must be usable as exactly one path segment: no separators
// (forward or back slash — Electron ships on Windows too), no ".." or "."
// (which would name the parent or the directory itself rather than a child
// of it), no null bytes, and non-empty. Anything else is rejected rather
// than stripped/escaped: silently rewriting an attacker-controlled string
// into "something plausible" is exactly the bug class this guards against.
const isValidWorkspaceId = (workspaceId: unknown): workspaceId is string => {
  if (typeof workspaceId !== 'string') return false
  if (workspaceId.length === 0) return false
  if (workspaceId === '.' || workspaceId === '..') return false
  if (workspaceId.includes('/') || workspaceId.includes('\\')) return false
  if (workspaceId.includes('..')) return false
  if (workspaceId.includes('\u0000')) return false
  return true
}

/** Pure. Derives Conductor's scratch paths for one workspace, all rooted
 *  under <userDataDir>/conductor/<workspaceId>/ — never inside the user's
 *  repository. Throws InvalidWorkspaceIdError instead of returning a
 *  plausible-looking path when workspaceId cannot be proven to name a single
 *  safe child directory. */
export function conductorPaths(
  userDataDir: string,
  workspaceId: string
): { integrationWorktree: string; lanesDir: string; journal: string } {
  if (!isValidWorkspaceId(workspaceId)) throw new InvalidWorkspaceIdError(workspaceId)

  const base = join(userDataDir, 'conductor', workspaceId)

  // Belt and suspenders on top of the string checks above: prove the
  // resolved directory really does land inside userDataDir before handing
  // out paths derived from it.
  const resolvedUserData = resolve(userDataDir)
  const resolvedBase = resolve(base)
  if (resolvedBase !== resolvedUserData && !resolvedBase.startsWith(resolvedUserData + sep)) {
    throw new InvalidWorkspaceIdError(workspaceId)
  }

  return {
    integrationWorktree: join(base, 'integration'),
    lanesDir: join(base, 'lanes'),
    journal: join(base, 'journal.ndjson')
  }
}

export interface CreateConductorRuntimeDeps {
  config: ConductorConfig
  journalPath: string
  createSession: ComposeDeps['createSession']
  closeSession: ComposeDeps['closeSession']
}

/** Assembles the live ConductorRuntime for one workspace from its persisted
 *  ConductorConfig. Does not itself call conductorPaths(): the caller (Task 6)
 *  derives journalPath (and the config's own integrationWorktree/lanesDir)
 *  once, up front, so this factory has a single, already-validated source of
 *  truth for where things live. */
export function createConductorRuntime(deps: CreateConductorRuntimeDeps): ConductorRuntime {
  const { config, journalPath, createSession, closeSession } = deps

  const settings: ConductorSettings = {
    repo: config.repo,
    integrationBranch: config.integrationBranch,
    integrationWorktree: config.integrationWorktree,
    lanesDir: config.lanesDir,
    maxLanes: config.maxLanes,
    test: config.test
  }

  const lanes = createLaneManager(settings)
  const journal = createJournal(journalPath)
  const conductor = createConductor({ lanes, journal, settings })

  return { lanes, conductor, settings, createSession, closeSession }
}
