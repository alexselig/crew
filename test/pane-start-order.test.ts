import { describe, it, expect, vi } from 'vitest'
import { startPaneSession } from '../src/renderer/terminal/start-pane'

/**
 * Regression: a restored session still spawned at the 100x30 default.
 *
 * Opening a pane did two things in the wrong order. `window.crew.wake(id)` ran
 * synchronously on mount, while the pane's measured size only reached the main
 * process from `fit()`, which first ran a frame later inside
 * requestAnimationFrame. The agent was therefore spawned before anyone told it
 * how wide the pane was, and the real width arrived ~16ms after it had already
 * booted and drawn its first layout.
 *
 * SessionManager was never the problem: it already spawns at the last reported
 * size. It just had nothing but the default to work with, because nobody had
 * reported yet.
 */
describe('a pane reports its size before starting the agent', () => {
  it('measures first, then wakes', () => {
    const calls: string[] = []
    const fit = vi.fn(() => {
      calls.push('fit')
      return { cols: 161, rows: 45 }
    })
    const wake = vi.fn(() => {
      calls.push('wake')
    })

    startPaneSession('s0', fit, wake)

    // Order is the whole point: reversing these is the bug.
    expect(calls).toEqual(['fit', 'wake'])
    expect(wake).toHaveBeenCalledWith('s0')
  })

  it('still wakes when the pane cannot be measured yet', () => {
    // A collapsed or not-yet-laid-out mount returns null. Refusing to start the
    // agent would be a worse bug than starting it at the remembered size.
    const wake = vi.fn()
    startPaneSession('s0', () => null, wake)
    expect(wake).toHaveBeenCalledWith('s0')
  })

  it('still wakes when measuring throws', () => {
    const wake = vi.fn()
    startPaneSession(
      's0',
      () => {
        throw new Error('container not measurable')
      },
      wake
    )
    expect(wake).toHaveBeenCalledWith('s0')
  })
})
