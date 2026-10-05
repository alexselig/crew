// Usage counting must never be the reason something on screen breaks.
//
// This is a regression test with a real origin: wiring countUsage straight to
// window.crew.recordUsage took out nine renderer tests at once, because the
// test harnesses build partial crew bridges and the missing method threw
// inside a render effect. In production the method exists — but a counter
// that can break the app is not worth having under any circumstances.
import { afterEach, describe, it, expect, vi } from 'vitest'
import { countUsage } from '../src/renderer/usage'

const original = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = original
})

function withCrew(crew: unknown): void {
  ;(globalThis as { window: unknown }).window = { crew }
}

describe('renderer usage counting', () => {
  it('forwards the event and its fields to the bridge', () => {
    const recordUsage = vi.fn(() => Promise.resolve())
    withCrew({ recordUsage })
    countUsage('view.used', { v: 'grid' })
    expect(recordUsage).toHaveBeenCalledWith('view.used', { v: 'grid' })
  })

  it('passes empty fields when none are given', () => {
    const recordUsage = vi.fn(() => Promise.resolve())
    withCrew({ recordUsage })
    countUsage('session.prompt')
    expect(recordUsage).toHaveBeenCalledWith('session.prompt', {})
  })

  it('survives a bridge that has no recordUsage', () => {
    withCrew({})
    expect(() => countUsage('view.used')).not.toThrow()
  })

  it('survives there being no bridge at all', () => {
    withCrew(undefined)
    expect(() => countUsage('view.used')).not.toThrow()
  })

  it('survives a bridge that throws synchronously', () => {
    withCrew({
      recordUsage: () => {
        throw new Error('bridge gone')
      }
    })
    expect(() => countUsage('view.used')).not.toThrow()
  })

  it('swallows a rejected call rather than leaving an unhandled rejection', () => {
    withCrew({ recordUsage: () => Promise.reject(new Error('ipc failed')) })
    expect(() => countUsage('view.used')).not.toThrow()
  })

  it('survives a bridge that returns nothing instead of a promise', () => {
    withCrew({ recordUsage: () => undefined })
    expect(() => countUsage('view.used')).not.toThrow()
  })
})
