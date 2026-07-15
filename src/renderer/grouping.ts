import type { SessionInfo } from '../shared/types'
import { NEEDS_YOU } from '../shared/types'

export type GroupMode = 'none' | 'needs' | 'tag' | 'recent'

export interface SessionGroup {
  name: string
  items: SessionInfo[]
  kind?: 'needs'
}

const needsYou = (s: SessionInfo): boolean => s.status === 'active' && NEEDS_YOU.includes(s.state)

const MIN = 60_000
const HOUR = 60 * MIN

/** Recency buckets by how long ago the user last prompted the session
 * (lastPromptAt), most-recent first. `max` is the exclusive upper age bound in
 * ms; the last bucket catches everything older. */
const RECENT_BUCKETS: Array<{ name: string; max: number }> = [
  { name: 'Last 30 min', max: 30 * MIN },
  { name: 'Last 2 hrs', max: 2 * HOUR },
  { name: 'Last day', max: 24 * HOUR },
  { name: 'Last week+', max: Number.POSITIVE_INFINITY }
]

function recentBucket(ageMs: number): string {
  for (const b of RECENT_BUCKETS) if (ageMs < b.max) return b.name
  return RECENT_BUCKETS[RECENT_BUCKETS.length - 1].name
}

/** The timestamp a session is bucketed by in 'recent' mode: the user's last
 * prompt, falling back to creation time for sessions never prompted. */
function recencyOf(s: SessionInfo): number {
  return s.lastPromptAt ?? s.createdAt
}

/** Bucket sessions for grouped display. Roster order is preserved within each
 * group. 'tag' groups by the session's group label ("Ungrouped" when unset);
 * 'needs' splits into "Needs you" and "Working"; 'recent' buckets by how long
 * ago the user last prompted the session (Last 30 min / 2 hrs / day / week+).
 * `order` applies the user's
 * manual group ordering; groups not present in `order` keep their natural
 * (first-appearance) order after the ordered ones. */
export function groupSessions(
  roster: SessionInfo[],
  mode: GroupMode,
  order: string[] = []
): SessionGroup[] {
  const groups: SessionGroup[] = []
  if (mode === 'tag') {
    const idx = new Map<string, number>()
    for (const s of roster) {
      const name = s.tag && s.tag.trim() ? s.tag : 'Ungrouped'
      if (!idx.has(name)) {
        idx.set(name, groups.length)
        groups.push({ name, items: [] })
      }
      groups[idx.get(name) as number].items.push(s)
    }
  } else if (mode === 'needs') {
    const needs = roster.filter(needsYou)
    const rest = roster.filter((s) => !needsYou(s))
    if (needs.length) groups.push({ name: 'Needs you', items: needs, kind: 'needs' })
    if (rest.length) groups.push({ name: 'Working', items: rest })
  } else if (mode === 'recent') {
    const now = Date.now()
    const byBucket = new Map<string, SessionInfo[]>()
    for (const s of roster) {
      const name = recentBucket(now - recencyOf(s))
      const arr = byBucket.get(name)
      if (arr) arr.push(s)
      else byBucket.set(name, [s])
    }
    // Emit buckets in fixed recent→old order; sort each oldest-first (by last
    // prompt) so a freshly prompted session appends to the BOTTOM of its bucket
    // instead of shoving the others down (minimal tile jumping).
    for (const b of RECENT_BUCKETS) {
      const items = byBucket.get(b.name)
      if (items && items.length) {
        items.sort((x, y) => recencyOf(x) - recencyOf(y))
        groups.push({ name: b.name, items })
      }
    }
  }
  if (order.length) {
    const rank = (name: string): number => {
      const i = order.indexOf(name)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    // Array.sort is stable in V8, so equal-rank (unordered) groups keep order.
    groups.sort((a, b) => rank(a.name) - rank(b.name))
  }
  return groups
}

/** Unique, sorted group labels currently in use (for autocomplete). */
export function existingGroups(roster: SessionInfo[]): string[] {
  const set = new Set<string>()
  for (const s of roster) if (s.tag && s.tag.trim()) set.add(s.tag.trim())
  return [...set].sort((a, b) => a.localeCompare(b))
}
