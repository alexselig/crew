// Decision for the *fallback* user-input row highlight (when a session has no
// OSC 133 shell integration). Pure so it is unit-tested in node.
//
// Sessions WITH shell integration (crew-hook / OSC 133) get an accurate prompt
// highlight driven by the semantic marks, so the coarse Enter-based fallback is
// suppressed for them. For sessions without marks we only highlight when the
// press looks like a real line prompt: NOT a full-screen/redraw TUI (alternate
// buffer), and the cursor is on the bottom input line. This prevents the
// "highlights in random places" seen when blindly tinting the cursor row on
// every Enter inside an agent TUI that repaints the screen.

export interface EnterHighlightState {
  /** The session has emitted OSC 133 marks (shell integration is active). */
  hasSemanticMarks: boolean
  /** The terminal is on the alternate screen buffer (a full-screen TUI). */
  altActive: boolean
  /** The cursor is on the bottom-most viewport row (a plausible input line). */
  cursorAtBottom: boolean
}

export function shouldHighlightInputOnEnter(s: EnterHighlightState): boolean {
  return !s.hasSemanticMarks && !s.altActive && s.cursorAtBottom
}
