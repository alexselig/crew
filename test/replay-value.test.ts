import { describe, expect, it, vi } from 'vitest'
import { ReplayValue } from '../src/preload/replay-value'

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
})
