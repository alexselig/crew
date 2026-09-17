import { describe, expect, it, vi } from 'vitest'
import { initialAppActivity, ReplayValue } from '../src/preload/replay-value'

describe('ReplayValue', () => {
  it('replays a value published before the renderer subscribes', () => {
    const value = new ReplayValue(true)
    value.publish(false)
    const listener = vi.fn()

    const unsubscribe = value.subscribe(listener)

    expect(listener).toHaveBeenCalledWith(false)
    unsubscribe()
  })

  it('publishes later values once and removes unsubscribed listeners', () => {
    const value = new ReplayValue(true)
    const listener = vi.fn()
    const unsubscribe = value.subscribe(listener)
    listener.mockClear()

    value.publish(false)
    unsubscribe()
    value.publish(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(false)
  })

  it('exposes the current replay value synchronously', () => {
    const value = new ReplayValue(true)
    value.publish(false)
    expect(value.current()).toBe(false)
  })

  it('reads initial activity from the window launch argument', () => {
    expect(initialAppActivity(['electron', '--crew-app-active=0'])).toBe(false)
    expect(initialAppActivity(['electron', '--crew-app-active=1'])).toBe(true)
  })

  it('fails open when the initial activity argument is absent or malformed', () => {
    expect(initialAppActivity(['electron'])).toBe(true)
    expect(initialAppActivity(['electron', '--crew-app-active=maybe'])).toBe(true)
  })
})
