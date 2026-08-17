// Workspaces: a session can belong to several named "sets" (workspaces), e.g.
// a Crew session that lives in both "July 2026" and "Microsoft July 2026".
// Switching the active workspace filters which sessions are shown (non-
// destructive — hidden sessions keep running). These helpers are pure and
// dependency-free so both main and renderer can share them and unit-test them.

/** Trim, drop empties, and de-duplicate workspace names, preserving first-seen order. */
export function normalizeSetNames(input: readonly (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const name = (raw ?? '').trim()
    if (!name) continue
    // De-dupe case-insensitively so "Work" and "work" don't both appear, but
    // keep the first spelling the user typed.
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Whether a session belongs to the active workspace. A null `active` means "All
 * Sessions" (no filter) and matches everything.
 */
export function sessionInWorkspace(
  sessionSets: readonly string[] | undefined,
  active: string | null
): boolean {
  if (!active) return true
  if (!sessionSets) return false
  const key = active.toLowerCase()
  return sessionSets.some((s) => s.trim().toLowerCase() === key)
}

/**
 * The union of all known workspace names — from explicitly saved sets and from
 * every session's membership — sorted case-insensitively for stable menus.
 */
export function workspaceNames(
  setNames: readonly string[],
  sessionMemberships: readonly (readonly string[] | undefined)[]
): string[] {
  const all: string[] = [...setNames]
  for (const m of sessionMemberships) if (m) all.push(...m)
  return normalizeSetNames(all).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  )
}

/** Add `name` to a membership list (no-op if already present, case-insensitive). */
export function addToSets(sets: readonly string[] | undefined, name: string): string[] {
  return normalizeSetNames([...(sets ?? []), name])
}

/** Remove `name` from a membership list (case-insensitive). */
export function removeFromSets(sets: readonly string[] | undefined, name: string): string[] {
  const key = name.trim().toLowerCase()
  return normalizeSetNames((sets ?? []).filter((s) => s.trim().toLowerCase() !== key))
}

// ── First-class workspaces (ids) ─────────────────────────────────────────────
// The helpers above operate on legacy name-based membership; those below are the
// first-class model used by the Workspace Manager: Workspace entities carry a
// stable id, and a session's membership is a list of workspace ids. All pure.

import type { Workspace } from './types'
export type { Workspace }

/** A short, collision-resistant workspace id (never the display name). */
export function makeWorkspaceId(): string {
  return 'ws_' + Math.random().toString(36).slice(2, 10)
}

const norm = (s: string): string => s.trim().toLowerCase()

/** Add a workspace with the next order. Returns created:null on blank or a
 *  case-insensitive duplicate name. */
export function createWorkspace(
  list: readonly Workspace[],
  name: string,
  now: number
): { list: Workspace[]; created: Workspace | null } {
  const trimmed = name.trim()
  if (!trimmed || list.some((w) => norm(w.name) === norm(trimmed))) {
    return { list: [...list], created: null }
  }
  const order = list.reduce((max, w) => Math.max(max, w.order), -1) + 1
  const created: Workspace = { id: makeWorkspaceId(), name: trimmed, order, createdAt: now }
  return { list: [...list, created], created }
}

/** Rename by id; no-op on blank or a duplicate of a *different* workspace. */
export function renameWorkspace(list: readonly Workspace[], id: string, name: string): Workspace[] {
  const trimmed = name.trim()
  if (!trimmed) return [...list]
  if (list.some((w) => w.id !== id && norm(w.name) === norm(trimmed))) return [...list]
  return list.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
}

/** Set (or clear, when blank) a workspace's description. */
export function describeWorkspace(list: readonly Workspace[], id: string, description: string): Workspace[] {
  const trimmed = description.trim()
  return list.map((w) => (w.id === id ? { ...w, description: trimmed || undefined } : w))
}

/** Remove a workspace by id. */
export function deleteWorkspace(list: readonly Workspace[], id: string): Workspace[] {
  return list.filter((w) => w.id !== id)
}

/** Rewrite each workspace's `order` to match `orderedIds` and sort by it. */
export function reorderWorkspaces(list: readonly Workspace[], orderedIds: readonly string[]): Workspace[] {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  return list
    .map((w) => ({ ...w, order: rank.has(w.id) ? (rank.get(w.id) as number) : w.order }))
    .sort((a, b) => a.order - b.order)
}

/** Add a workspace id to a session's membership (no-op if already present). */
export function addMembership(ids: readonly string[] | undefined, wsId: string): string[] {
  const cur = ids ?? []
  return cur.includes(wsId) ? [...cur] : [...cur, wsId]
}

/** Remove a workspace id from a session's membership. */
export function removeMembership(ids: readonly string[] | undefined, wsId: string): string[] {
  return (ids ?? []).filter((x) => x !== wsId)
}

/** Move membership from one workspace to another (drop `fromId`, add `toId`). */
export function moveMembership(
  ids: readonly string[] | undefined,
  fromId: string,
  toId: string
): string[] {
  return addMembership(removeMembership(ids, fromId), toId)
}

/** A session is archived when it belongs to no workspace. */
export function isArchived(ids: readonly string[] | undefined): boolean {
  return !ids || ids.length === 0
}

/** Membership test by workspace id. A null active id means "All" (matches all). */
export function sessionInWorkspaceId(ids: readonly string[] | undefined, activeId: string | null): boolean {
  if (!activeId) return true
  return !!ids && ids.includes(activeId)
}

/** Lowercased workspace name → id (used by the one-time name→id migration). */
export function nameToIdMap(list: readonly Workspace[]): Map<string, string> {
  return new Map(list.map((w) => [norm(w.name), w.id]))
}
