import { describe, it, expect, vi, beforeEach } from 'vitest'

// The facade wires two engine pools (legacy xterm + the new Crew engine), both
// of which import xterm/DOM. Mock them so the routing logic can be tested in the
// node vitest environment without a browser.
const { legacy, crew } = vi.hoisted(() => ({
  legacy: {
    writeTo: vi.fn(),
    focusTerminal: vi.fn(),
    disposePooled: vi.fn()
  },
  crew: {
    writeTo: vi.fn(),
    focusTerminal: vi.fn(),
    disposePooled: vi.fn(),
    getBlocks: vi.fn(() => [{ id: 1, state: 'done', startedAt: 0 }]),
    jumpToPrompt: vi.fn(() => true),
    copySelection: vi.fn(() => Promise.resolve('sel'))
  }
}))

vi.mock('../src/renderer/terminal-pool', () => legacy)
vi.mock('../src/renderer/terminal/pool', () => crew)

import {
  setEngineMode,
  getEngineMode,
  writeTo,
  focusTerminal,
  disposePooled,
  getBlocks,
  jumpToPrompt,
  copySelection
} from '../src/renderer/terminal/facade'

beforeEach(() => {
  setEngineMode('legacy')
  vi.clearAllMocks()
})

describe('terminal facade — app-wide engine routing', () => {
  it('defaults to the legacy engine', () => {
    expect(getEngineMode()).toBe('legacy')
  })

  it('routes output to the legacy pool when off', () => {
    writeTo('s1', 'data')
    expect(legacy.writeTo).toHaveBeenCalledWith('s1', 'data')
    expect(crew.writeTo).not.toHaveBeenCalled()
  })

  it('routes output to the Crew pool when enhanced is on', () => {
    setEngineMode('crew')
    writeTo('s1', 'data')
    expect(crew.writeTo).toHaveBeenCalledWith('s1', 'data')
    expect(legacy.writeTo).not.toHaveBeenCalled()
  })

  it('routes focus per the active engine', () => {
    focusTerminal('s1')
    expect(legacy.focusTerminal).toHaveBeenCalledWith('s1')
    setEngineMode('crew')
    focusTerminal('s2')
    expect(crew.focusTerminal).toHaveBeenCalledWith('s2')
  })

  it('disposes BOTH pools on close (session id never reused)', () => {
    disposePooled('s1')
    expect(legacy.disposePooled).toHaveBeenCalledWith('s1')
    expect(crew.disposePooled).toHaveBeenCalledWith('s1')
  })

  it('exposes blocks only for the Crew engine', () => {
    expect(getBlocks('s1')).toEqual([])
    expect(crew.getBlocks).not.toHaveBeenCalled()
    setEngineMode('crew')
    expect(getBlocks('s1')).toHaveLength(1)
    expect(crew.getBlocks).toHaveBeenCalledWith('s1')
  })

  it('jump-to-prompt and copy are no-ops under legacy, active under Crew', async () => {
    expect(jumpToPrompt('s1', 'next')).toBe(false)
    expect(await copySelection('s1')).toBe('')
    setEngineMode('crew')
    expect(jumpToPrompt('s1', 'next')).toBe(true)
    expect(await copySelection('s1')).toBe('sel')
  })
})
