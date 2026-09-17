import { beforeEach, describe, expect, it, vi } from 'vitest'

const { terminals } = vi.hoisted(() => {
  const terminals: Array<{ written: string[]; disposed: boolean }> = []
  return { terminals }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element = null
    textarea = null
    buffer = { active: { length: 0, getLine: () => null } }
    cols = 80
    rows = 24
    written: string[] = []
    disposed = false
    constructor() {
      terminals.push(this)
    }
    loadAddon(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose() {} }
    }
    write(data: string): void {
      this.written.push(data)
    }
    dispose(): void {
      this.disposed = true
    }
    focus(): void {}
    registerMarker(): null {
      return null
    }
    registerDecoration(): null {
      return null
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('../src/renderer/preview-bus', () => ({ previewToken: vi.fn() }))

import {
  TAIL_LIMIT,
  disposePooled,
  dormantTerminalCount,
  getPooled,
  liveTerminalCount,
  previewText,
  resetPoolForTests,
  setRenderingActive,
  writeTo
} from '../src/renderer/terminal-pool'

beforeEach(() => {
  resetPoolForTests()
  terminals.length = 0
  ;(globalThis as { window?: unknown }).window = { crew: { openExternal: vi.fn() } }
})

describe('legacy terminal suspension', () => {
  it('retires live terminals and does not allocate for background output', () => {
    getPooled('visible')
    setRenderingActive(false)
    writeTo('visible', 'recent')
    writeTo('new', 'background')

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(2)
    expect(terminals).toHaveLength(1)
    expect(terminals[0].disposed).toBe(true)
  })

  it('replays recent output only when the visible terminal is reacquired', () => {
    setRenderingActive(false)
    writeTo('sleeping', 'recent output')
    expect(previewText('sleeping')).toContain('recent output')
    expect(terminals).toHaveLength(0)

    setRenderingActive(true)
    const pooled = getPooled('sleeping')
    expect((pooled.term as unknown as { written: string[] }).written.join('')).toContain('recent output')
    expect(terminals).toHaveLength(1)
  })

  it('bounds one oversized dormant chunk without splitting Unicode', () => {
    setRenderingActive(false)
    const output = 'old🚀' + 'n'.repeat(TAIL_LIMIT + 20)
    writeTo('sleeping', output)

    expect(previewText('sleeping', TAIL_LIMIT).join('\n').length).toBeLessThanOrEqual(TAIL_LIMIT)
    setRenderingActive(true)
    const pooled = getPooled('sleeping')
    const replay = (pooled.term as unknown as { written: string[] }).written.join('')
    expect(replay).toBe(output.slice(-TAIL_LIMIT))
    expect(replay.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00)
  })

  it('keeps suspension idempotent and does not resurrect a tombstoned session', () => {
    getPooled('closed')
    setRenderingActive(false)
    setRenderingActive(false)
    disposePooled('closed')
    writeTo('closed', 'late output')
    setRenderingActive(true)

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(0)
  })
})
