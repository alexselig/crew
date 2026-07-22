// Decides whether a keydown should drive grid column navigation (arrow keys
// scrolling the dashboard left/right). Kept dependency-free so it can be unit
// tested in the node vitest environment and reused by the capture-phase
// keyboard listener in App.tsx.

/** The pieces of `document.activeElement` the arrow router cares about. */
export interface ActiveElementInfo {
  /** `el.tagName` (upper-cased by the DOM), e.g. 'INPUT', 'TEXTAREA'. */
  tag: string | null
  /** `el.isContentEditable`. */
  isContentEditable: boolean
  /**
   * True when focus sits on xterm's hidden input (a
   * `<textarea class="xterm-helper-textarea">`). A focused terminal is treated
   * as an editable target so Left/Right reach the session's prompt (caret /
   * shell line editing) instead of paging the dashboard.
   */
  isTerminal: boolean
}

export type ArrowNavIntent = 'left' | 'right' | null

/** Keyboard modifier flags (a subset of KeyboardEvent). */
export interface KeyMods {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

/**
 * A control where Left/Right must move the caret, so the grid must NOT hijack the
 * arrow. This includes real text fields AND a focused xterm terminal: when the
 * user is typing into a session's prompt, arrows edit the line rather than paging
 * the dashboard. (Grid column nav still works when focus is not in a terminal or
 * text field — e.g. while scanning the grid without having clicked into a tile.)
 */
export function isEditableTarget(active: ActiveElementInfo | null): boolean {
  if (!active) return false
  return (
    active.isTerminal ||
    active.tag === 'INPUT' ||
    active.tag === 'TEXTAREA' ||
    active.tag === 'SELECT' ||
    active.isContentEditable
  )
}

/**
 * Returns which way the grid should step for this keydown, or null when the app
 * should leave the event alone.
 *
 * Grid column nav only fires for a plain (unmodified) Left/Right arrow while the
 * grid is on screen and focus is not in a text field or a session terminal.
 * Up/Down and modified arrows return null so they keep flowing to the terminal or
 * browser.
 */
export function arrowNavIntent(
  key: string,
  mods: KeyMods,
  active: ActiveElementInfo | null,
  hasGrid: boolean
): ArrowNavIntent {
  if (mods.metaKey || mods.ctrlKey || mods.altKey) return null
  const dir: ArrowNavIntent = key === 'ArrowRight' ? 'right' : key === 'ArrowLeft' ? 'left' : null
  if (!dir) return null
  if (!hasGrid) return null
  if (isEditableTarget(active)) return null
  return dir
}
