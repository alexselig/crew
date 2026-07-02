import type { SessionInfo } from '../shared/types'
import { NEEDS_YOU } from '../shared/types'

export type GroupMode = 'none' | 'needs' | 'tag'

export interface SessionGroup {
  name: string
  items: SessionInfo[]
  kind?: 'needs'
}

const needsYou = (s: SessionInfo): boolean => s.status === 'active' && NEEDS_YOU.includes(s.state)

/** Bucket sessions for grouped display. Roster order is preserved within each
 * group. 'tag' groups by the session's group label ("Ungrouped" when unset);
 * 'needs' splits into "Needs you" and "Working". `order` applies the user's
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
