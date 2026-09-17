import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityPoller } from '../src/renderer/activity-poller'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createActivityPoller', () => {
  it('does nothing while inactive', () => {
    const run = vi.fn()
    const poller = createActivityPoller(500, run)
    vi.advanceTimersByTime(2_000)
    expect(run).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    poller.dispose()
  })

  it('runs immediately and then on the requested interval', async () => {
    const run = vi.fn()
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.runAllTicks()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(3)
    poller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues one resume refresh without overlapping a slow async run', async () => {
    let release: (() => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(run).toHaveBeenCalledTimes(1)
    poller.setActive(false)
    poller.setActive(true)
    expect(run).toHaveBeenCalledTimes(1)
    release?.()
    await vi.runAllTicks()
    expect(run).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('stops permanently after disposal even if an outstanding run settles', async () => {
    let release: (() => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.runAllTicks()
    poller.dispose()
    release?.()
    await vi.runAllTicks()
    vi.advanceTimersByTime(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
