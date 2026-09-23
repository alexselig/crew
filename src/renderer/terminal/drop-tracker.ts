/**
 * Tracking whether a file drag is currently over a terminal pane.
 *
 * dragenter and dragleave fire for every child element, so a naive boolean
 * flickers. The usual fix is a depth counter -- but a depth counter strands the
 * overlay the first time a pair is unbalanced, and a stranded overlay is not a
 * cosmetic problem: it is a tinted panel at z-index 5 covering the terminal,
 * with pointer-events: none, so the pane looks blank and the session cannot be
 * dropped on again. The counter lives per pane, which is why the symptom is
 * "drag and drop stopped working for this one session".
 *
 * Pairs go unbalanced routinely:
 *   - the drag is cancelled with Esc while over the pane,
 *   - it leaves the window entirely (no further dragleave on the pane),
 *   - the drop lands on a different element,
 *   - the drop event's dataTransfer does not advertise 'Files', so a handler
 *     that checks that first returns before resetting anything.
 *
 * So this deliberately separates "counting" from "ending". Anything that ends
 * a drag clears the state outright rather than decrementing, and the caller is
 * expected to wire the window-level end events too -- a drag that ends outside
 * the pane never sends the pane another event.
 */
export class DropTracker {
  private depth = 0

  /** True when the drop overlay should be visible. */
  get active(): boolean {
    return this.depth > 0
  }

  /**
   * A drag entered the pane or one of its children. Non-file drags (Crew's own
   * card reordering) are ignored so they never raise the file overlay.
   */
  enter(hasFiles: boolean): boolean {
    if (hasFiles) this.depth++
    return this.active
  }

  /** A drag left the pane or one of its children. */
  leave(hasFiles: boolean): boolean {
    if (hasFiles) this.depth = Math.max(0, this.depth - 1)
    return this.active
  }

  /**
   * The drag is over -- dropped, cancelled, or gone from the window. Always
   * clears, whatever the payload claimed, because this is the only thing
   * standing between an unbalanced pair and a permanently blanked pane.
   */
  end(): boolean {
    this.depth = 0
    return this.active
  }
}

/** Whether a drag carries files (as opposed to Crew's internal card drags). */
export function dragHasFiles(types: readonly string[] | DOMStringList): boolean {
  return Array.from(types as ArrayLike<string>).includes('Files')
}
