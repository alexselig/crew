import { describe, it, expect } from 'vitest'
import { shouldHighlightInputOnEnter } from '../src/shared/highlight'

describe('shouldHighlightInputOnEnter', () => {
  it('highlights a plain line prompt: no marks, normal buffer, cursor at bottom', () => {
    expect(
      shouldHighlightInputOnEnter({ hasSemanticMarks: false, altActive: false, cursorAtBottom: true })
    ).toBe(true)
  })

  it('suppresses the Enter fallback when shell integration (OSC 133) is active', () => {
    // Those sessions get an accurate prompt highlight from the semantic marks.
    expect(
      shouldHighlightInputOnEnter({ hasSemanticMarks: true, altActive: false, cursorAtBottom: true })
    ).toBe(false)
  })

  it('never highlights inside a full-screen TUI (alternate buffer)', () => {
    expect(
      shouldHighlightInputOnEnter({ hasSemanticMarks: false, altActive: true, cursorAtBottom: true })
    ).toBe(false)
  })

  it('does not highlight when the cursor is not on the bottom input line', () => {
    // e.g. a redraw TUI whose input widget has a status/hint row below it.
    expect(
      shouldHighlightInputOnEnter({ hasSemanticMarks: false, altActive: false, cursorAtBottom: false })
    ).toBe(false)
  })
})
