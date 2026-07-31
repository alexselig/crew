// update.ts — shared types + a small semver compare for the in-app update check.
// Crew publishes signed releases to GitHub; the main process compares the running
// app version against the latest release tag and, when a newer one exists, tells
// the renderer to surface a dismissible "update available" banner. This is an
// awareness+one-click-download notifier (not a silent auto-installer).

export interface UpdateInfo {
  /** The latest published version, e.g. "0.4.5". */
  version: string
  /** The GitHub release page (Download / release notes live there). */
  url: string
  /** ISO date the release was published, when known. */
  publishedAt: string | null
}

/**
 * Compare two dotted numeric versions (a leading "v" is ignored). Returns 1 when
 * a > b, -1 when a < b, and 0 when equal. Missing segments are treated as 0, so
 * "0.4" === "0.4.0". Non-numeric/garbage segments compare as 0 (defensive — a
 * malformed tag should never rank as "newer" and nag users).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    String(v)
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((n) => {
        const x = parseInt(n, 10)
        return Number.isFinite(x) ? x : 0
      })
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}
