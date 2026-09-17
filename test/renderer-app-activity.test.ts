import { describe, expect, it, vi } from 'vitest'
import { applyAppActivity } from '../src/renderer/app-activity-state'

describe('applyAppActivity', () => {
  it('synchronizes resources before publishing React state', () => {
    const order: string[] = []
    const terminal = vi.fn(() => order.push('terminal'))
    const publish = vi.fn(() => order.push('publish'))

    applyAppActivity(false, [terminal], publish)

    expect(order).toEqual(['terminal', 'publish'])
    expect(terminal).toHaveBeenCalledWith(false)
    expect(publish).toHaveBeenCalledWith(false)
  })

  it('runs every resource synchronizer before publishing React state', () => {
    const order: string[] = []

    applyAppActivity(
      true,
      [() => order.push('terminal'), () => order.push('clock')],
      () => order.push('publish')
    )

    expect(order).toEqual(['terminal', 'clock', 'publish'])
  })
})
