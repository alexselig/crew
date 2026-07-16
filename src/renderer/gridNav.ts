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
   * `<textarea class="xterm-helper-textarea">`). In grid view its arrows should
   * scroll the dashboard, NOT be typed into the PTY — so it is deliberately not
   * treated as an editable text field here.
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
 * A genuine text control where Left/Right must move the caret, so the grid must
 * NOT hijack the arrow. The xterm terminal textarea is intentionally excluded:
 * in grid view we want its arrows to page the dashboard instead.
 */
export function isEditableTarget(active: ActiveElementInfo | null): boolean {
  if (!active) return false
  if (active.isTerminal) return false
  return (
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
 * grid is on screen and focus is not in a real text field. Up/Down and modified
 * arrows return null so they keep flowing to the terminal or browser.
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
