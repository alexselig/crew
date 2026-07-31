// updater.ts — lightweight "update available" check against GitHub Releases.
// Deliberately NOT a silent auto-installer: it fetches the latest published
// release, compares it to the running version, and (when newer) hands the
// renderer an UpdateInfo so it can show a dismissible banner with a one-click
// download. Read-only + best-effort — any failure is swallowed so a network
// blip never affects the app.

import { app } from 'electron'
import { isNewer, type UpdateInfo } from '../shared/update'

const REPO = 'alexselig/crew'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
// Re-check periodically so a long-running app still learns about new releases.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Fetch the latest published release and return UpdateInfo when it is strictly
 * newer than the running app; otherwise null. Never throws.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Crew/${app.getVersion()}`
      },
      // Guard against a hung request keeping a handle alive.
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      tag_name?: string
      html_url?: string
      published_at?: string
      draft?: boolean
      prerelease?: boolean
    }
    if (json.draft || json.prerelease || !json.tag_name) return null
    const version = json.tag_name.replace(/^v/i, '')
    if (!isNewer(version, app.getVersion())) return null
    return {
      version,
      url: json.html_url || `https://github.com/${REPO}/releases/latest`,
      publishedAt: json.published_at ?? null
    }
  } catch {
    return null
  }
}

/**
 * Start background update checks: once shortly after launch, then on an interval.
 * `onUpdate` is called with the newest UpdateInfo found (only when newer). Returns
 * a stop function that clears the timer.
 */
export function startUpdateChecks(onUpdate: (info: UpdateInfo) => void): () => void {
  let stopped = false
  const run = async (): Promise<void> => {
    const info = await checkForUpdate()
    if (!stopped && info) onUpdate(info)
  }
  // A short delay after launch keeps startup snappy and lets the network settle.
  const first = setTimeout(() => void run(), 8000)
  const timer = setInterval(() => void run(), CHECK_INTERVAL_MS)
  return () => {
    stopped = true
    clearTimeout(first)
    clearInterval(timer)
  }
}
