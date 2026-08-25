// GitHub remote-URL helpers shared by the main process (the Project Tracker and
// the per-session GitHub button) and unit tests. Pure string logic — no node or
// electron imports — so it is safe to use from either side and easy to test.

/**
 * Normalize a raw `git remote` URL to a browsable https GitHub URL, or null when
 * it isn't an http(s)/ssh-style remote. Handles scp-style
 * `git@github.com:owner/repo.git` and strips a trailing `.git`.
 */
export function githubUrlFrom(raw: string): string | null {
  if (!raw) return null
  let u = raw.trim()
  if (u.startsWith('git@')) u = u.replace(':', '/').replace('git@', 'https://')
  u = u.replace(/\.git$/, '')
  return u.startsWith('http') ? u : null
}

/** True when a normalized URL points at github.com (not, say, a GitLab remote). */
export function isGithubUrl(url: string | null): boolean {
  return !!url && /^https?:\/\/(www\.)?github\.com\//i.test(url)
}
