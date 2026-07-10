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
