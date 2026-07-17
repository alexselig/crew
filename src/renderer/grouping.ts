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
const DAY = 24 * HOUR

/** Recency buckets by how long ago the user last prompted the session
 * (lastPromptAt), most-recent first. `max` is the exclusive upper age bound in
 * ms; the last bucket catches everything older. */
const RECENT_BUCKETS: Array<{ name: string; max: number }> = [
  { name: 'Last 30 min', max: 30 * MIN },
  { name: 'Last 2 hrs', max: 2 * HOUR },
  { name: 'Last day', max: DAY },
  { name: 'Last week+', max: Number.POSITIVE_INFINITY }
]

/** Count-based fallback buckets used when the roster spans more than a day —
 * where the time buckets would dump most sessions into the oldest bucket. Ranges
 * are by recency rank (0-based, most-recent first): [start, end). */
const RANK_BUCKETS: Array<{ name: string; start: number; end: number }> = [
  { name: '4 most recent', start: 0, end: 4 },
  { name: '5-12 most recent', start: 4, end: 12 },
  { name: '13+ most recent', start: 12, end: Number.POSITIVE_INFINITY }
]

// Stable within-bucket ordering for 'recent' mode. A session keeps its slot
// (position) while it stays in a bucket, so re-prompting or the clock ticking
// doesn't reshuffle the visible list; a session is only re-slotted — appended
// to the END of a bucket — the first time it enters that bucket. seq is a
// monotonic counter so later entrants always sort after earlier ones.
interface BucketSlot {
  bucket: string
  seq: number
}
const bucketSlots = new Map<string, BucketSlot>()
let bucketSeq = 0

/** Reset the 'recent' within-bucket order memory. Test-only. */
export function _resetRecencyOrder(): void {
  bucketSlots.clear()
  bucketSeq = 0
}

function recentBucket(ageMs: number): string {
  for (const b of RECENT_BUCKETS) if (ageMs < b.max) return b.name
  return RECENT_BUCKETS[RECENT_BUCKETS.length - 1].name
}

/** The timestamp a session is bucketed by in 'recent' mode: the user's last
 * prompt, falling back to creation time for sessions never prompted. */
function recencyOf(s: SessionInfo): number {
  return s.lastPromptAt ?? s.createdAt
}

/** Split a group's sessions (preserving order) into those used at or after
 * `staleBeforeMs` and the stale rest. Used for the per-group "show more" in
 * group (tag) sort, which hides sessions not used within a configured window. */
export function partitionStale(
  items: SessionInfo[],
  staleBeforeMs: number
): { recent: SessionInfo[]; stale: SessionInfo[] } {
  const recent: SessionInfo[] = []
  const stale: SessionInfo[] = []
  for (const s of items) {
    if (recencyOf(s) >= staleBeforeMs) recent.push(s)
    else stale.push(s)
  }
  return { recent, stale }
}

/** Bucket sessions for grouped display. Roster order is preserved within each
 * group. 'tag' groups by the session's group label ("Ungrouped" when unset);
 * 'needs' splits into "Needs you" and "Working"; 'recent' buckets by how long
 * ago the user last prompted the session (Last 30 min / 2 hrs / day / week+) —
 * but when the roster spans more than a day AND fewer than 2 sessions have been
 * prompted within the last day, it falls back to count-based buckets (4 most
 * recent / 5-12 most recent / 13+ most recent) so groups stay a sane size. Once
 * 2+ sessions get fresh prompts it switches back to the time buckets. Within a
 * bucket the
 * order is stable: a session holds its slot while it stays in a bucket and is
 * appended to the end only when it first enters one (see bucketSlots).
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
    // Newest-first ranking by last-prompt time (createdAt fallback).
    const ranked = [...roster].sort((a, b) => recencyOf(b) - recencyOf(a))
    // Sessions prompted within the last day land in a finite time bucket (not
    // "week+"), so they're what makes the time buckets useful.
    const recentActive = ranked.filter((s) => now - recencyOf(s) < DAY).length
    // Fall back to the count-based rank buckets only when the roster spans more
    // than a day AND there isn't enough recent activity to populate the time
    // buckets. As soon as 2+ sessions get fresh prompts, switch back to time
    // buckets so the active work resurfaces into the fine-grained recent groups
    // instead of staying stuck in "4 / 5-12 most recent".
    const useRankBuckets =
      ranked.length > 0 &&
      now - recencyOf(ranked[ranked.length - 1]) > DAY &&
      recentActive < 2

    // Assign each session to a bucket. When the rank fallback is active, use the
    // count-based buckets (predictable group sizes); otherwise the time buckets.
    // `bucketNames` fixes the recent→old emit order.
    const bucketNames = useRankBuckets
      ? RANK_BUCKETS.map((b) => b.name)
      : RECENT_BUCKETS.map((b) => b.name)
    const bucketOf = new Map<string, string>()
    if (useRankBuckets) {
      ranked.forEach((s, i) => {
        const b =
          RANK_BUCKETS.find((rb) => i >= rb.start && i < rb.end) ??
          RANK_BUCKETS[RANK_BUCKETS.length - 1]
        bucketOf.set(s.id, b.name)
      })
    } else {
      for (const s of roster) bucketOf.set(s.id, recentBucket(now - recencyOf(s)))
    }

    // Refresh order slots: a session keeps its slot while it stays in a bucket
    // (no reshuffle), and gets a fresh, higher seq — landing at the END of the
    // bucket — the first time it enters it. First-seen sessions are seeded in
    // oldest-first order so the initial layout reads newest-at-bottom.
    for (const s of [...roster].sort((a, b) => recencyOf(a) - recencyOf(b))) {
      const bkt = bucketOf.get(s.id) as string
      const cur = bucketSlots.get(s.id)
      if (!cur || cur.bucket !== bkt) bucketSlots.set(s.id, { bucket: bkt, seq: bucketSeq++ })
    }

    const byBucket = new Map<string, SessionInfo[]>()
    for (const s of roster) {
      const name = bucketOf.get(s.id) as string
      const arr = byBucket.get(name)
      if (arr) arr.push(s)
      else byBucket.set(name, [s])
    }
    for (const name of bucketNames) {
      const items = byBucket.get(name)
      if (items && items.length) {
        items.sort(
          (x, y) => (bucketSlots.get(x.id) as BucketSlot).seq - (bucketSlots.get(y.id) as BucketSlot).seq
        )
        groups.push({ name, items })
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
