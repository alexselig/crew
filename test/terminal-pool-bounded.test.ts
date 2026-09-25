// The bounded terminal pool — the fix for the renderer OOM that showed up as
// window flicker.
//
// Background agents stream output forever, so an unbounded pool kept one live
// xterm per session parsing and buffering for panes nobody was watching until
// the renderer exhausted its memory and Blink aborted with
// "Oilpan: Large allocation ... out of memory". Every reload of the dead
// renderer repainted the whole window — the flicker.
//
// These tests assert the two properties that keep that from coming back:
//   1. the number of live emulators is bounded no matter how many sessions run
//   2. a session that loses its emulator loses no semantics — blocks and the
//      typed transcript keep accruing, and reopening replays recent output
//
// The engine is mocked (vitest runs in node, xterm needs a DOM), which is fine
// because everything under test lives in the pool, not the emulator.

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface FakeEngine {
  written: string[]
  disposed: boolean
  mounted: boolean
}

const { engines, createXtermEngine } = vi.hoisted(() => {
  const engines: FakeEngine[] = []
  const createXtermEngine = vi.fn(() => {
    const e = {
      written: [] as string[],
      disposed: false,
      mounted: false,
      write(d: string) {
        e.written.push(d)
      },
      dispose() {
        e.disposed = true
      },
      setLinkActivator() {},
      registerLinkProvider: () => ({ dispose() {} }),
      addMarker: () => null,
      decorate: () => ({ dispose() {} }),
      focus() {},
      getVisibleText: () => e.written.join(''),
      // The real engine returns an escape-sequence snapshot; the fake keeps it
      // as the written text, which is enough for the pool-level behaviour under
      // test here (the sequence's fidelity is covered by a browser test).
      serialize: () => e.written.join(''),
      get altActive() {
        return false
      },
      get cursorAtBottom() {
        return true
      }
    }
    engines.push(e as unknown as FakeEngine)
    return e
  })
  return { engines, createXtermEngine }
})

vi.mock('../src/renderer/terminal/xterm-engine', () => ({ createXtermEngine }))
vi.mock('../src/renderer/preview-bus', () => ({ previewToken: vi.fn() }))

import {
  writeTo,
  getPooled,
  touch,
  getBlocks,
  getTranscript,
  recordInput,
  disposePooled,
  liveEngineCount,
  dormantCount,
  retireAllPooled,
  resetPoolForTests,
  setRenderingActive,
  MAX_LIVE_ENGINES,
  TAIL_LIMIT
} from '../src/renderer/terminal/pool'

/** The pool is typed against the real engine; these tests drive the mock. */
const asFake = (e: unknown): FakeEngine => e as FakeEngine

const BEL = '\u0007'
const ESC = '\u001b'
/** One complete OSC 133 command cycle — the shell-integration marks the pool
 *  turns into semantic blocks and transcript entries. */
const CYCLE = `${ESC}]133;A${BEL}${ESC}]133;B${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`

beforeEach(() => {
  resetPoolForTests()
  engines.length = 0
  vi.mocked(createXtermEngine).mockClear()
  ;(globalThis as { window?: unknown }).window = { crew: { openExternal: vi.fn() } }
})

describe('bounded terminal engine pool', () => {
  it('bounds one oversized chunk without truncating live output', () => {
    const data = 'old'.repeat(TAIL_LIMIT) + 'newest'
    writeTo('oversized', data)
    const p = getPooled('oversized')
    expect(asFake(p.engine).written.join('')).toBe(data)
    expect(p.tailLen).toBe(TAIL_LIMIT)
    expect(p.tailParts.join('')).toBe(data.slice(-TAIL_LIMIT))
  })

  it('keeps the newest suffix when only part of the oldest chunk must go', () => {
    const first = 'a'.repeat(TAIL_LIMIT - 4)
    writeTo('partial', first)
    writeTo('partial', 'newest-tail')
    const p = getPooled('partial')
    expect(p.tailLen).toBe(TAIL_LIMIT)
    expect(p.tailParts.join('')).toBe((first + 'newest-tail').slice(-TAIL_LIMIT))
  })

  it.each([false, true])('does not split a surrogate pair at the replay boundary (split chunks: %s)', (split) => {
    if (split) {
      writeTo('unicode', 'old\ud83d')
      writeTo('unicode', '\ude80' + 'n'.repeat(TAIL_LIMIT - 1))
    } else {
      writeTo('unicode', 'old🚀' + 'n'.repeat(TAIL_LIMIT - 1))
    }
    const p = getPooled('unicode')
    expect(p.tailLen).toBe(TAIL_LIMIT - 1)
    expect(p.tailParts.join('')).toBe('n'.repeat(TAIL_LIMIT - 1))
  })

  it('bounds oversized dormant output and replays it without duplicating semantics', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES; i++) writeTo(`s${i}`, 'x')
    const data = 'old'.repeat(TAIL_LIMIT) + CYCLE + 'newest'
    writeTo('oversized-dormant', data)
    expect(getBlocks('oversized-dormant')).toHaveLength(1)
    const p = getPooled('oversized-dormant')
    expect(p.tailLen).toBe(TAIL_LIMIT)
    expect(asFake(p.engine).written.join('')).toBe(data.slice(-TAIL_LIMIT))
    expect(getBlocks('oversized-dormant')).toHaveLength(1)
  })

  it('preserves complete Unicode at the limit and across subsequent appends', () => {
    const data = '🚀'.repeat(TAIL_LIMIT / 2)
    writeTo('exact', data)
    let p = getPooled('exact')
    expect(p.tailLen).toBe(TAIL_LIMIT)
    expect(p.tailParts.join('')).toBe(data)
    let all = data
    for (const chunk of ['a', '🚀', '', 'last']) {
      all += chunk
      writeTo('exact', chunk)
      p = getPooled('exact')
      expect(p.tailLen).toBeLessThanOrEqual(TAIL_LIMIT)
      expect(p.tailLen).toBe(p.tailParts.join('').length)
      expect(p.tailParts.join('')).toBe(all.slice(-TAIL_LIMIT).replace(/^[\udc00-\udfff]/, ''))
    }
  })

  it('caps live emulators no matter how many sessions produce output', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES * 4; i++) writeTo(`s${i}`, 'hello')
    expect(liveEngineCount()).toBeLessThanOrEqual(MAX_LIVE_ENGINES)
    // Nothing is dropped — the rest are dormant, not gone.
    expect(liveEngineCount() + dormantCount()).toBe(MAX_LIVE_ENGINES * 4)
  })

  it('never allocates an emulator for a session that arrives past the cap', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES; i++) writeTo(`s${i}`, 'x')
    const before = engines.length
    for (let i = 0; i < 40; i++) writeTo(`late${i}`, 'x')
    // The allocation that used to kill the renderer never happens.
    expect(engines.length).toBe(before)
  })

  it('keeps parsing blocks and the transcript for a session with no emulator', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES; i++) writeTo(`s${i}`, 'x')
    writeTo('dormant-1', `${ESC}]133;A${BEL}`)
    recordInput('dormant-1', 'npm test')
    writeTo('dormant-1', `${ESC}]133;B${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`)

    expect(dormantCount()).toBeGreaterThan(0)
    expect(getBlocks('dormant-1')).toHaveLength(1)
    const tx = getTranscript('dormant-1')
    expect(tx.some((b) => b.kind === 'tool' && b.command === 'npm test')).toBe(true)
  })

  it('replays recent output and continues the same history when reopened', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES; i++) writeTo(`s${i}`, 'x')
    writeTo('later', `${CYCLE}visible-tail`)

    const p = getPooled('later')
    expect(asFake(p.engine).written.join('')).toContain('visible-tail')
    // Reopening must not restart the session's semantics...
    expect(getBlocks('later')).toHaveLength(1)
    // ...nor double-count them by re-parsing the replayed tail.
    writeTo('later', CYCLE)
    expect(getBlocks('later')).toHaveLength(2)
  })

  it('retires every live emulator when terminal rendering is suspended', () => {
    getPooled('visible')
    writeTo('background', 'before')
    expect(liveEngineCount()).toBe(2)

    setRenderingActive(false)

    expect(liveEngineCount()).toBe(0)
    expect(dormantCount()).toBe(2)
    expect(engines.every((engine) => engine.disposed)).toBe(true)
  })

  it('keeps parsing output without allocating while suspended', () => {
    setRenderingActive(false)
    writeTo('sleeping', CYCLE + 'recent output')

    expect(createXtermEngine).not.toHaveBeenCalled()
    expect(liveEngineCount()).toBe(0)
    expect(getBlocks('sleeping')).toHaveLength(1)
    expect(getTranscript('sleeping')).toHaveLength(1)
  })

  it('replays one bounded tail after resume without duplicating semantics', () => {
    setRenderingActive(false)
    writeTo('sleeping', CYCLE + 'recent output')
    setRenderingActive(true)

    const pooled = getPooled('sleeping')

    expect(asFake(pooled.engine).written.join('')).toContain('recent output')
    expect(getBlocks('sleeping')).toHaveLength(1)
    expect(liveEngineCount()).toBe(1)
  })

  it('keeps suspension idempotent and preserves tombstones', () => {
    getPooled('closed')
    setRenderingActive(false)
    setRenderingActive(false)
    disposePooled('closed')
    writeTo('closed', 'late output')
    setRenderingActive(true)

    expect(liveEngineCount()).toBe(0)
    expect(dormantCount()).toBe(0)
  })

  it('retires the least-recently-viewed session, never the one on screen', () => {
    const p = getPooled('watched')
    asFake(p.engine).mounted = true
    touch('watched')
    for (let i = 0; i < MAX_LIVE_ENGINES * 2; i++) writeTo(`bg${i}`, 'x')

    expect(liveEngineCount()).toBeLessThanOrEqual(MAX_LIVE_ENGINES)
    expect(asFake(p.engine).disposed).toBe(false)
    expect(getPooled('watched')).toBe(p)
  })

  it('disposes the engine of a retired session (the memory actually goes back)', () => {
    vi.useFakeTimers()
    try {
      getPooled('doomed')
      const doomed = engines[0]
      // Separate the view times so "least recently viewed" is unambiguous.
      vi.advanceTimersByTime(1000)
      // Fill the cap, then open one more: that is what forces a retirement.
      for (let i = 0; i < MAX_LIVE_ENGINES; i++) writeTo(`bg${i}`, 'x')
      getPooled('newcomer')
      expect(doomed.disposed).toBe(true)
      expect(liveEngineCount()).toBeLessThanOrEqual(MAX_LIVE_ENGINES)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retiring the whole pool preserves visible scrollback for reattach', () => {
    writeTo('mode-switch', 'old scrollback\n')
    writeTo('mode-switch', 'new output\n')
    const first = getPooled('mode-switch')

    retireAllPooled()

    expect(liveEngineCount()).toBe(0)
    expect(dormantCount()).toBe(1)
    expect(asFake(first.engine).disposed).toBe(true)

    const reopened = getPooled('mode-switch')
    expect(asFake(reopened.engine).written.join('')).toContain('old scrollback')
    expect(asFake(reopened.engine).written.join('')).toContain('new output')
  })

  it('retiring the whole pool disposes every engine so renderer resources are released', () => {
    for (let i = 0; i < 4; i++) getPooled(`webgl-${i}`)

    retireAllPooled()

    expect(liveEngineCount()).toBe(0)
    expect(engines.slice(0, 4).every((engine) => engine.disposed)).toBe(true)
  })

  it('forgets a closed session entirely, live or dormant', () => {
    for (let i = 0; i < MAX_LIVE_ENGINES * 2; i++) writeTo(`s${i}`, CYCLE)
    const total = liveEngineCount() + dormantCount()
    disposePooled('s0')
    disposePooled('s20')
    expect(liveEngineCount() + dormantCount()).toBe(total - 2)
    // A late chunk from a killed PTY must not resurrect it.
    writeTo('s0', 'zombie')
    expect(getBlocks('s0')).toEqual([])
  })
})
