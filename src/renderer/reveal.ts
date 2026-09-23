// Where a session's tile should land when the grid scrolls it into view.
//
// The grid scrolls HORIZONTALLY: a fixed number of rows fills the height and
// tiles flow into columns, two of which are visible. `nearest` therefore lands
// a session wherever costs the least scrolling — usually the RIGHT column, or
// nowhere at all when the tile is already partly visible. That is right for an
// incidental reveal (the selected session re-buckets and its tile moves) and
// wrong for a deliberate one: picking a session in the nav should put it where
// the eye starts, at the left edge.
//
// Selection alone cannot tell the two apart, because clicking a tile and
// clicking a nav row both end at `setSelectedId`. A navigation records a
// request here; a bare selection does not.

export type RevealRequest = { id: string; seq: number }

/** True when `request` is a live navigation to `selectedId`. */
export function isDeliberateReveal(
  selectedId: string | null,
  request: RevealRequest | null | undefined
): boolean {
  return Boolean(selectedId && request && request.id === selectedId)
}

/**
 * The `inline` alignment for `scrollIntoView`. A deliberate navigation aligns
 * the tile to the left edge; anything else moves as little as possible.
 */
export function revealInline(
  selectedId: string | null,
  request: RevealRequest | null | undefined
): ScrollLogicalPosition {
  return isDeliberateReveal(selectedId, request) ? 'start' : 'nearest'
}

/**
 * Effect key for a reveal. Navigating to the session that is *already*
 * selected must still re-align it, so the sequence number participates; a
 * selection with no matching request collapses to null so an unrelated
 * navigation elsewhere cannot re-scroll this session.
 */
export function revealKey(
  selectedId: string | null,
  request: RevealRequest | null | undefined
): number | null {
  return isDeliberateReveal(selectedId, request) ? (request as RevealRequest).seq : null
}
