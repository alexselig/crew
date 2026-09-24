import { describe, it, expect, vi } from 'vitest'
import { repairRendering } from '../src/renderer/terminal/repair'

describe('repairing a mangled pane', () => {
  it('clears every pane before asking the agents to redraw', async () => {
    const calls: string[] = []
    const clear = vi.fn((id: string) => {
      calls.push('clear:' + id)
    })
    const signal = vi.fn(async () => {
      calls.push('redraw')
      return 2
    })

    const repaired = await repairRendering(['a', 'b'], clear, signal)

    // Reversing this leaves a blank pane: the clear would wipe the redraw.
    expect(calls).toEqual(['clear:a', 'clear:b', 'redraw'])
    expect(repaired).toBe(2)
  })

  it('still redraws when a pane has no emulator to clear', async () => {
    const signal = vi.fn(async () => 1)
    const repaired = await repairRendering(
      ['a'],
      () => {
        throw new Error('retired')
      },
      signal
    )
    expect(signal).toHaveBeenCalled()
    expect(repaired).toBe(1)
  })
})
