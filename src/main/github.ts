// Resolve the GitHub repo URL for a session's working directory by reading its
// `origin` remote. Read-only, times out, and never rejects — safe to call from
// an IPC handler on demand (used by the session header's GitHub button).

import { execFile } from 'node:child_process'
import { githubUrlFrom, isGithubUrl } from '../shared/github'

/**
 * The GitHub URL of `cwd`'s `origin` remote, or null when the directory isn't a
 * git repo, has no origin, or the origin isn't a GitHub remote.
 */
export function resolveGithubUrl(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!cwd || typeof cwd !== 'string') return resolve(null)
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
