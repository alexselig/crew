import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppActivityCoordinator } from '../src/main/app-activity'

interface FakeWindow {
  focused: boolean
  isFocused(): boolean
}

describe('AppActivityCoordinator', () => {
  let windows: FakeWindow[]
  let sent: boolean[]
  let queued: (() => void)[]
  let coordinator: AppActivityCoordinator<FakeWindow>

  beforeEach(() => {
    windows = []
    sent = []
    queued = []
    coordinator = new AppActivityCoordinator(
      () => windows,
      (active) => sent.push(active),
      (run) => queued.push(run)
    )
  })

  it('reports inactive when no Crew window is focused', () => {
    windows = [{ focused: false, isFocused() { return this.focused } }]
    coordinator.recompute()
    expect(sent).toEqual([false])
  })

  it('reports active when any Crew window is focused', () => {
    windows = [
      { focused: false, isFocused() { return this.focused } },
      { focused: true, isFocused() { return this.focused } }
    ]
    coordinator.recompute()
    expect(sent).toEqual([true])
  })

  it('does not rebroadcast an unchanged state', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    coordinator.recompute()
    coordinator.recompute()
    expect(sent).toEqual([true])
  })

  it('coalesces adjacent lifecycle events before recomputing', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    coordinator.schedule()
    coordinator.schedule()
    expect(queued).toHaveLength(1)
    windows[0].focused = false
    queued[0]()
    expect(sent).toEqual([false])
  })

  it('does not emit inactive while focus transfers between Crew windows', () => {
    windows = [
      { focused: true, isFocused() { return this.focused } },
      { focused: false, isFocused() { return this.focused } }
    ]
    coordinator.recompute()
    sent.length = 0

    windows[0].focused = false
    coordinator.schedule()
    windows[1].focused = true
    coordinator.schedule()
    queued[0]()

    expect(sent).toEqual([])
  })

  it('sends the current state directly to a newly ready renderer', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    const ready = vi.fn()
    coordinator.sendCurrent(ready)
    expect(ready).toHaveBeenCalledWith(true)
    expect(sent).toEqual([])
  })
})
