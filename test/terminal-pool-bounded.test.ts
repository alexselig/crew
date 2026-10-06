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
  getVisibleText: () => string
  /** The link provider the pool registered, captured so the wiring can be
   *  exercised without a DOM. */
  linkProvider?: {
    provide: (line: string, y: number) => { start: number; end: number; text: string }[]
    activate: (text: string) => void
  }
  /** Overridable per test: a real emulator cannot serialize a sequence its
   *  parser has only half-consumed, and that difference is load-bearing. */
  serialize: () => string
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
      registerLinkProvider: (p: unknown) => {
        ;(e as { linkProvider?: unknown }).linkProvider = p
        return { dispose() {} }
      },
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
import { previewToken } from '../src/renderer/preview-bus'

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

  // An escape sequence cut in half by the replay bound leaves its remainder as
  // printable text, which is how `2;145;152;161m` appears mid-session.
  // The second mechanism, independent of the replay bound: an engine retired
  // part-way through a sequence takes the consumed half with it. The snapshot
  // cannot carry it — it is parser state, not rendered output — so without the
  // pending fragment the continuation prints as `2;164;117;249m`.
  it('replays the fragment a retired parser was part-way through', () => {
    writeTo('midseq', 'hello' + ESC + '[38;')
    // Model a faithful emulator: the open sequence is not in its output.
    const live = asFake(engines[engines.length - 1])
    live.serialize = () => 'hello'
    retireAllPooled()
    writeTo('midseq', '2;164;117;249mWORLD')
    const written = asFake(getPooled('midseq').engine).written.join('')
    expect(written).toContain(ESC + '[38;2;164;117;249m')
    expect(written).not.toContain('hello2;164')
  })

  // The prefix is owed exactly once; a second rebuild must not re-emit it.
  it('does not replay the fragment twice across two rebuilds', () => {
    writeTo('once', 'hello' + ESC + '[38;')
    asFake(engines[engines.length - 1]).serialize = () => 'hello'
    retireAllPooled()
    writeTo('once', '2;164;117;249mWORLD')
    getPooled('once')
    retireAllPooled()
    const written = asFake(getPooled('once').engine).written.join('')
    expect(written.split(ESC + '[38;').length - 1).toBe(1)
  })

  // When no snapshot is taken the tail is kept whole, fragment included, so
  // replaying a prefix as well would duplicate it.
  it('does not replay the fragment when the tail is kept instead', () => {
    writeTo('notsnap', 'hello' + ESC + '[38;')
    // snapshotOf falls back to visible text, so a truly snapshot-less engine
    // must yield nothing from either source.
    const live = asFake(engines[engines.length - 1])
    live.serialize = () => ''
    live.getVisibleText = () => ''
    retireAllPooled()
    writeTo('notsnap', '2;164;117;249mWORLD')
    const written = asFake(getPooled('notsnap').engine).written.join('')
    expect(written.split(ESC + '[38;').length - 1).toBe(1)
    expect(written).toContain(ESC + '[38;2;164;117;249mWORLD')
  })

  it.each([false, true])('does not replay half an escape sequence (split chunks: %s)', (split) => {
    const SGR = `${ESC}[38;2;145;152;161m`
    if (split) {
      writeTo('ansi', 'old' + ESC + '[38;')
      writeTo('ansi', '2;145;152;161m' + 'n'.repeat(TAIL_LIMIT - 14))
    } else {
      writeTo('ansi', 'old' + SGR + 'n'.repeat(TAIL_LIMIT - 14))
    }
    const tail = getPooled('ansi').tailParts.join('')
    expect(tail.startsWith('2;145;152;161m')).toBe(false)
    expect(tail).not.toContain('145;152;161m')
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

  it('retires every unmounted emulator when terminal rendering is suspended', () => {
    getPooled('visible')
    writeTo('background', 'before')
    expect(liveEngineCount()).toBe(2)

    setRenderingActive(false)

    expect(liveEngineCount()).toBe(0)
    expect(dormantCount()).toBe(2)
    expect(engines.every((engine) => engine.disposed)).toBe(true)
  })

  // Dragging a file in from Finder requires Crew to be unfocused, and resuming
  // replays from a snapshot, which loses the scroll position. Neither may cost
  // the user the pane they are actually working in.
  // Keeping a mounted engine in the pool is only safe if writeTo agrees that
  // the pool wins. transcriptOf and getBlocks both prefer the pool entry, so a
  // dormant shadow built during blur would be permanently unreachable.
  it('writes straight to the on-screen engine while the app is inactive', () => {
    const p = getPooled('watched')
    asFake(p.engine).mounted = true

    setRenderingActive(false)
    writeTo('watched', CYCLE + 'while away')
    setRenderingActive(true)

    expect(asFake(p.engine).written.join('')).toContain('while away')
    expect(getPooled('watched')).toBe(p)
    expect(dormantCount()).toBe(0)
    expect(getBlocks('watched')).toHaveLength(1)
    expect(getTranscript('watched')).toHaveLength(1)
  })

  it('keeps the on-screen engine alive when the app goes inactive', () => {
    const p = getPooled('watched')
    asFake(p.engine).mounted = true
    writeTo('background', 'before')

    setRenderingActive(false)

    expect(liveEngineCount()).toBe(1)
    expect(dormantCount()).toBe(1)
    expect(asFake(p.engine).disposed).toBe(false)
    expect(getPooled('watched')).toBe(p)
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

describe('clickable links in session output', () => {
  const providerFor = (id: string) => {
    getPooled(id)
    const p = asFake(engines[engines.length - 1]).linkProvider
    if (!p) throw new Error('pool registered no link provider')
    return p
  }

  it('offers a bare URL as a link', () => {
    const got = providerFor('links').provide('Server on http://localhost:5173/ now', 1)
    expect(got.map((m) => m.text)).toEqual(['http://localhost:5173/'])
  })

  it('still offers a previewable file path as a link', () => {
    const got = providerFor('links').provide('wrote ./out/shot.png', 1)
    expect(got.map((m) => m.text)).toEqual(['./out/shot.png'])
  })

  it('opens a clicked URL in the browser', () => {
    providerFor('links').activate('https://crew.dev/docs')
    expect(window.crew.openExternal).toHaveBeenCalledWith('https://crew.dev/docs')
  })

  it('gives a scheme-less www link one before opening it', () => {
    providerFor('links').activate('www.crew.dev')
    expect(window.crew.openExternal).toHaveBeenCalledWith('https://www.crew.dev')
  })

  it('previews a clicked file path instead of opening a browser', () => {
    providerFor('links').activate('./out/shot.png')
    expect(previewToken).toHaveBeenCalledWith('links', './out/shot.png')
    expect(window.crew.openExternal).not.toHaveBeenCalled()
  })
})
