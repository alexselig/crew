import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getNowSnapshot,
  resetNowClockForTests,
  setNowClockActive,
  subscribeNow
} from '../src/renderer/now-clock'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  resetNowClockForTests()
})

afterEach(() => vi.useRealTimers())

describe('shared now clock', () => {
  it('uses one interval for multiple subscribers', () => {
    const a = vi.fn()
    const b = vi.fn()
    vi.setSystemTime(2_000)
    const stopA = subscribeNow(a)
    const stopB = subscribeNow(b)
    expect(getNowSnapshot()).toBe(2_000)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    stopA()
    stopB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops while inactive and emits a fresh timestamp on resume', () => {
    const listener = vi.fn()
    const stop = subscribeNow(listener)
    setNowClockActive(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(9_000)
    setNowClockActive(true)
    expect(getNowSnapshot()).toBe(9_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    stop()
  })
})
