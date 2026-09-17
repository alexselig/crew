import { describe, expect, it, vi } from 'vitest'
import { TerminalFocusRegistry } from '../src/renderer/terminal-focus'

interface FakeEngine {
  onFocus(cb: () => void): { dispose(): void }
}

function engine() {
  let focus: (() => void) | null = null
  const value: FakeEngine = {
    onFocus: vi.fn((cb: () => void) => {
      focus = cb
      return { dispose() {} }
    })
  }
  return {
    value,
    focus: () => {
      if (!focus) throw new Error('focus listener was not bound')
      focus()
    }
  }
}

describe('enhanced terminal focus tracking', () => {
  it('rebinds after suspend/resume and restores only the most recently focused session', () => {
    const registry = new TerminalFocusRegistry()
    const firstA = engine()
    registry.bind('session-a', firstA.value)
    firstA.focus()
    expect(registry.shouldRestore('session-a', true, true)).toBe(true)

    const resumedA = engine()
    registry.bind('session-a', resumedA.value)
    expect(resumedA.value.onFocus).toHaveBeenCalledTimes(1)
    registry.bind('session-a', resumedA.value)
    expect(resumedA.value.onFocus).toHaveBeenCalledTimes(1)

    const sessionB = engine()
    registry.bind('session-b', sessionB.value)
    sessionB.focus()

    expect(registry.shouldRestore('session-a', true, true)).toBe(false)
    expect(registry.shouldRestore('session-b', true, true)).toBe(true)
    expect(registry.shouldRestore('session-b', false, true)).toBe(false)
    expect(registry.shouldRestore('session-b', true, false)).toBe(false)
  })
})
