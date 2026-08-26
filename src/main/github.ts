// Resolve the GitHub repo URL for a session's working directory by reading its
// `origin` remote. Read-only, times out, and never rejects — safe to call from
// an IPC handler on demand (used by the session header's GitHub button).

import { execFile } from 'node:child_process'
import { githubUrlFrom, isGithubUrl } from '../shared/github'

/** How long a resolved remote is trusted before we shell out to git again. */
const TTL_MS = 30_000

interface Entry {
  at: number
  value: string | null
}

const cache = new Map<string, Entry>()
/** Resolutions currently in flight, keyed by cwd, so N callers cost one git. */
const inFlight = new Map<string, Promise<string | null>>()

/** Count of actual `git` spawns, so tests can assert the work stays bounded. */
let spawns = 0

function run(cwd: string): Promise<string | null> {
  spawns++
  return new Promise((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout) => {
        if (err) return resolve(null)
        const url = githubUrlFrom(String(stdout).trim())
        resolve(isGithubUrl(url) ? url : null)
      }
    )
  })
}

/**
 * The GitHub URL of `cwd`'s `origin` remote, or null when the directory isn't a
 * git repo, has no origin, or the origin isn't a GitHub remote.
 *
 * Cached and de-duplicated, because the caller is a React button that re-asks
 * on every mount and on every window focus. Without this, a burst of re-renders
 * across a full roster spawns one `git` per session per render: that reached
 * ~2,000 concurrent processes here, exhausted the per-user process table
 * (`fork: Resource temporarily unavailable`) and left the app flickering and
 * unusable. A remote changes on the order of never, so a short TTL costs
 * nothing and bounds the work to one git per directory per TTL.
 */
export function resolveGithubUrl(cwd: string): Promise<string | null> {
  if (!cwd || typeof cwd !== 'string') return Promise.resolve(null)

  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.value)

  const pending = inFlight.get(cwd)
  if (pending) return pending

  const p = run(cwd)
    .then((value) => {
      cache.set(cwd, { at: Date.now(), value })
      return value
    })
    .finally(() => {
      inFlight.delete(cwd)
    })

  inFlight.set(cwd, p)
  return p
}

/** Test seam: drop all memoised remotes and reset the spawn counter. */
export function _resetGithubUrlCache(): void {
  cache.clear()
  inFlight.clear()
  spawns = 0
}

/** Test seam: how many `git` processes have actually been spawned. */
export function _gitSpawnCount(): number {
  return spawns
}
