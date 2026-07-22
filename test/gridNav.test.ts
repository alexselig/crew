import { describe, it, expect } from 'vitest'
import { arrowNavIntent, isEditableTarget, type ActiveElementInfo } from '../src/renderer/gridNav'

const NO_MODS = { metaKey: false, ctrlKey: false, altKey: false }

function active(over: Partial<ActiveElementInfo>): ActiveElementInfo {
  return { tag: null, isContentEditable: false, isTerminal: false, ...over }
}

// A focused xterm terminal: a <textarea class="xterm-helper-textarea">.
const TERMINAL = active({ tag: 'TEXTAREA', isTerminal: true })

describe('isEditableTarget', () => {
  it('is false for no focus', () => {
    expect(isEditableTarget(null)).toBe(false)
  })

  it('is true for real text controls', () => {
    expect(isEditableTarget(active({ tag: 'INPUT' }))).toBe(true)
    expect(isEditableTarget(active({ tag: 'TEXTAREA' }))).toBe(true)
    expect(isEditableTarget(active({ tag: 'SELECT' }))).toBe(true)
    expect(isEditableTarget(active({ tag: 'DIV', isContentEditable: true }))).toBe(true)
  })

  it('is true for a focused terminal textarea (arrows must reach the prompt)', () => {
    expect(isEditableTarget(TERMINAL)).toBe(true)
  })

  it('is false for non-editable chrome', () => {
    expect(isEditableTarget(active({ tag: 'BUTTON' }))).toBe(false)
  })
})

describe('arrowNavIntent', () => {
  it('pages the grid on plain Left/Right when chrome is focused', () => {
    expect(arrowNavIntent('ArrowRight', NO_MODS, null, true)).toBe('right')
    expect(arrowNavIntent('ArrowLeft', NO_MODS, null, true)).toBe('left')
  })

  // When a session terminal is focused the user is typing a prompt, so plain
  // Left/Right must move the caret across their text, not page between panes.
  it('yields to a focused tile terminal so arrows edit the prompt', () => {
    expect(arrowNavIntent('ArrowRight', NO_MODS, TERMINAL, true)).toBeNull()
    expect(arrowNavIntent('ArrowLeft', NO_MODS, TERMINAL, true)).toBeNull()
  })

  it('yields to real text fields so their caret keys work', () => {
    expect(arrowNavIntent('ArrowRight', NO_MODS, active({ tag: 'INPUT' }), true)).toBeNull()
    expect(arrowNavIntent('ArrowLeft', NO_MODS, active({ tag: 'TEXTAREA' }), true)).toBeNull()
    expect(arrowNavIntent('ArrowRight', NO_MODS, active({ tag: 'SELECT' }), true)).toBeNull()
    expect(
      arrowNavIntent('ArrowLeft', NO_MODS, active({ tag: 'DIV', isContentEditable: true }), true)
    ).toBeNull()
  })

  it('ignores Up/Down and non-arrow keys', () => {
    expect(arrowNavIntent('ArrowUp', NO_MODS, null, true)).toBeNull()
    expect(arrowNavIntent('ArrowDown', NO_MODS, null, true)).toBeNull()
    expect(arrowNavIntent('a', NO_MODS, null, true)).toBeNull()
    expect(arrowNavIntent('Enter', NO_MODS, TERMINAL, true)).toBeNull()
  })

  it('does nothing outside grid view (no scroll container)', () => {
    expect(arrowNavIntent('ArrowRight', NO_MODS, null, false)).toBeNull()
    expect(arrowNavIntent('ArrowRight', NO_MODS, TERMINAL, false)).toBeNull()
  })

  it('ignores arrows combined with a modifier', () => {
    expect(arrowNavIntent('ArrowRight', { ...NO_MODS, metaKey: true }, null, true)).toBeNull()
    expect(arrowNavIntent('ArrowRight', { ...NO_MODS, ctrlKey: true }, null, true)).toBeNull()
    expect(arrowNavIntent('ArrowLeft', { ...NO_MODS, altKey: true }, null, true)).toBeNull()
  })
})
