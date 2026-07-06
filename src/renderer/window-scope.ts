// Per-window view-state scoping.
//
// All Crew windows share one renderer origin, so they also share one
// `localStorage`. Persisting view preferences (grouping, density, nav, collapsed
// groups, …) to unscoped keys therefore couples every window: a second window on
// another screen inherits and clobbers the first window's layout, garbling the
// session display. To keep windows independent, the main process hands each
// window a numeric slot via `?w=<n>` and we namespace all view-state keys by it.
//
// Slot 0 is the primary window and falls back to the legacy unscoped keys, so an
// existing install keeps its saved layout after upgrading.

/** This window's slot (`?w=` query param), defaulting to 0 (primary window). */
export const windowSlot: number = (() => {
  if (typeof location === 'undefined') return 0
  const n = Number(new URLSearchParams(location.search).get('w'))
  return Number.isInteger(n) && n >= 0 ? n : 0
})()

/** localStorage key for a per-window view preference, scoped to this window. */
export function viewKey(name: string): string {
  return `crew.w${windowSlot}.${name}`
}

/**
 * Read a per-window view preference. The primary window (slot 0) migrates from
 * the pre-multi-window unscoped `crew.<name>` key the first time it's read.
 */
export function readViewPref(name: string): string | null {
  const scoped = localStorage.getItem(viewKey(name))
  if (scoped !== null) return scoped
  if (windowSlot === 0) return localStorage.getItem(`crew.${name}`)
  return null
}

/** Persist a per-window view preference, scoped to this window. */
export function writeViewPref(name: string, value: string): void {
  localStorage.setItem(viewKey(name), value)
}
