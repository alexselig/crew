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

  it('replays the fragment a retired parser was part-way through', () => {
    writeTo('midseq', 'hello\u001b[38;')
    // Give the terminal real buffer text so retirement takes a snapshot and
    // drops the tail — the path where the open fragment would be lost.
    const live = terminals[terminals.length - 1] as unknown as {
      buffer: { active: { length: number; getLine: (i: number) => unknown } }
    }
    live.buffer.active = {
      length: 1,
      getLine: () => ({ translateToString: () => 'hello' })
    }
    setRenderingActive(false)
    writeTo('midseq', '2;164;117;249mWORLD')
    setRenderingActive(true)
    const written = (getPooled('midseq').term as unknown as { written: string[] }).written.join('')
    expect(written).toContain('\u001b[38;2;164;117;249m')
    expect(written).not.toContain('hello2;164')
  })

  it('does not replay half an escape sequence after trimming', () => {
    // Same hazard as the enhanced pool: ESC[38; discarded, 2;145;152;161m left
    // behind, which replays as literal text rather than as a colour change.
    writeTo('ansi', 'old\u001b[38;2;145;152;161m' + 'n'.repeat(TAIL_LIMIT - 14))
    const tail = getPooled('ansi').tailParts.join('')
    expect(tail).not.toContain('145;152;161m')
  })
  it('retires background terminals and does not allocate for background output', () => {
    getPooled('visible')
    setRenderingActive(false)
    writeTo('visible', 'recent')
    writeTo('new', 'background')

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(2)
    expect(terminals).toHaveLength(1)
    expect(terminals[0].disposed).toBe(true)
  })

  // Blur is the normal state for the pane the user is working in: you cannot
  // drag a file out of Finder without Crew losing focus, and retiring replays
  // from a snapshot, which rebuilds the buffer and loses the scroll position.
  it('keeps a mounted terminal alive when the app goes inactive', () => {
    const pooled = getPooled('visible')
    pooled.opened = true
    ;(pooled.term as unknown as { element: unknown }).element = { isConnected: true }

    setRenderingActive(false)

    expect(liveTerminalCount()).toBe(1)
    expect(dormantTerminalCount()).toBe(0)
    expect(terminals[0].disposed).toBe(false)
  })

  it('retires a terminal whose element has been detached from the document', () => {
    const pooled = getPooled('hidden')
    pooled.opened = true
    ;(pooled.term as unknown as { element: unknown }).element = { isConnected: false }

    setRenderingActive(false)

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(1)
  })

  // Keeping a mounted terminal in the pool is only safe if writeTo agrees that
  // the pool wins. Diverting its output to a dormant tail would strand it in a
  // shadow entry nothing replays, and resume the parser mid-stream.
  it('writes straight to a mounted terminal while the app is inactive', () => {
    const pooled = getPooled('visible')
    pooled.opened = true
    ;(pooled.term as unknown as { element: unknown }).element = { isConnected: true }

    setRenderingActive(false)
    writeTo('visible', 'while away')
    setRenderingActive(true)

    expect((pooled.term as unknown as { written: string[] }).written.join('')).toContain(
      'while away'
    )
    expect(getPooled('visible')).toBe(pooled)
    expect(dormantTerminalCount()).toBe(0)
    expect(liveTerminalCount()).toBe(1)
  })

  it('does not strand blur-period output behind a live terminal', () => {
    const pooled = getPooled('visible')
    pooled.opened = true
    ;(pooled.term as unknown as { element: unknown }).element = { isConnected: true }
    writeTo('visible', 'before ')

    setRenderingActive(false)
    writeTo('visible', 'during ')
    setRenderingActive(true)
    writeTo('visible', 'after')

    expect((pooled.term as unknown as { written: string[] }).written.join('')).toBe(
      'before during after'
    )
    expect(previewText('visible').join('\n')).toContain('during')
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
