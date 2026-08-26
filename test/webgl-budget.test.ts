import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression: the render flicker that got worse the longer Crew ran.
 *
 * XtermEngine took a WebGL context on a terminal's first mount and never gave
 * it back. Pooled engines live for a session's whole lifetime, so the number of
 * live contexts grew with every session ever viewed. Chromium caps active WebGL
 * contexts per renderer (16) and force-loses the OLDEST one past the cap, so
 * each newly shown terminal silently knocked out another pane's renderer and
 * made it repaint — a flash somewhere the user wasn't even looking, getting
 * more frequent as the roster was worked through, and cleared by a restart.
 *
 * The engine now enforces its own budget and reclaims contexts from off-screen
 * terminals, so the browser is never the one choosing a victim.
 */

const { FakeWebglAddon, FakeTerminal } = vi.hoisted(() => {
  class FakeWebglAddon {
    static live = 0
    static created = 0
    disposed = false
    onLoss: (() => void) | null = null
    constructor() {
      FakeWebglAddon.live++
      FakeWebglAddon.created++
    }
    onContextLoss(cb: () => void): void {
      this.onLoss = cb
    }
    dispose(): void {
      if (this.disposed) return
      this.disposed = true
      FakeWebglAddon.live--
    }
  }

  class FakeTerminal {
    element: {
      parentElement: unknown
      isConnected: boolean
      querySelectorAll: () => unknown[]
    } | null = null
    textarea = null
    unicode = { activeVersion: '6' }
    buffer = { active: { type: 'normal', cursorY: 0, viewportY: 0, getLine: () => null } }
    cols = 80
    rows = 24
    loadAddon(): void {}
    open(host: { appendChild(el: unknown): void }): void {
      const el = {
        parentElement: null as unknown,
        isConnected: false,
        querySelectorAll: () => [] as unknown[]
      }
      this.element = el
      host.appendChild(el)
    }
    write(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    resize(): void {}
    focus(): void {}
    dispose(): void {}
    registerMarker(): null {
      return null
    }
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    attachCustomKeyEventHandler(): void {}
    getSelection(): string {
      return ''
    }
    scrollToLine(): void {}
  }

  return { FakeWebglAddon, FakeTerminal }
})

interface FakeEl {
  parentElement: FakeHost | null
  isConnected: boolean
  querySelectorAll: () => unknown[]
}

interface FakeHost {
  children: FakeEl[]
  appendChild(el: FakeEl): void
  removeChild(el: FakeEl): void
}

function makeHost(): FakeHost {
  const host: FakeHost = {
    children: [],
    appendChild(el) {
      host.children.push(el)
      el.parentElement = host
      el.isConnected = true
    },
    removeChild(el) {
      host.children = host.children.filter((c) => c !== el)
      el.parentElement = null
      el.isConnected = false
    }
  }
  return host
}

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: FakeWebglAddon }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }))

import {
  createXtermEngine,
  _webglContextCount,
  _resetWebglBudget,
  _MAX_WEBGL_CONTEXTS
} from '../src/renderer/terminal/xterm-engine'

/** One pooled session: an engine plus the DOM host its view mounts into. */
function makeSession(): { engine: ReturnType<typeof createXtermEngine>; host: FakeHost } {
  return { engine: createXtermEngine(), host: makeHost() }
}

beforeEach(() => {
  // Engines from a previous test are still in the module-level registry; they
  // would otherwise spend this test's budget before it starts.
  _resetWebglBudget()
  FakeWebglAddon.live = 0
  FakeWebglAddon.created = 0
})

describe('WebGL context budget', () => {
  it('stays under Chromium\u2019s 16-context cap', () => {
    expect(_MAX_WEBGL_CONTEXTS).toBeLessThan(16)
  })

  it('never exceeds the budget when a long roster is worked through', () => {
    // The reported scenario: click through many sessions one at a time. Each
    // pooled engine stays alive; only the visible one is mounted.
    const sessions = Array.from({ length: 40 }, makeSession)
    let shown: (typeof sessions)[number] | null = null

    for (const s of sessions) {
      if (shown) shown.engine.unmount(shown.host as unknown as HTMLElement)
      s.engine.mount(s.host as unknown as HTMLElement)
      shown = s
      // Before the fix this climbed to 40 and Chromium started evicting at 16.
      expect(FakeWebglAddon.live).toBeLessThanOrEqual(_MAX_WEBGL_CONTEXTS)
    }

    expect(_webglContextCount()).toBeLessThanOrEqual(_MAX_WEBGL_CONTEXTS)
  })

  it('never exceeds the budget with many terminals visible at once (grid view)', () => {
    const sessions = Array.from({ length: 20 }, makeSession)
    for (const s of sessions) {
      s.engine.mount(s.host as unknown as HTMLElement)
      expect(FakeWebglAddon.live).toBeLessThanOrEqual(_MAX_WEBGL_CONTEXTS)
    }
    expect(_webglContextCount()).toBe(_MAX_WEBGL_CONTEXTS)
  })

  it('never takes a context away from a terminal that is still visible', () => {
    // All budgeted contexts held by mounted (visible) terminals.
    const visible = Array.from({ length: _MAX_WEBGL_CONTEXTS }, makeSession)
    for (const s of visible) s.engine.mount(s.host as unknown as HTMLElement)
    const accelerated = visible.filter((s) => s.engine.capabilities.webgl)
    expect(accelerated.length).toBe(_MAX_WEBGL_CONTEXTS)

    // A further terminal is shown. It must fall back to the DOM renderer rather
    // than evict a visible pane — evicting one is exactly the flash we removed.
    const extra = makeSession()
    extra.engine.mount(extra.host as unknown as HTMLElement)
    expect(extra.engine.capabilities.webgl).toBe(false)
    for (const s of accelerated) expect(s.engine.capabilities.webgl).toBe(true)
    expect(FakeWebglAddon.live).toBe(_MAX_WEBGL_CONTEXTS)
  })

  it('reclaims a context from an off-screen terminal so a shown one is accelerated', () => {
    const sessions = Array.from({ length: _MAX_WEBGL_CONTEXTS }, makeSession)
    for (const s of sessions) s.engine.mount(s.host as unknown as HTMLElement)

    // Hide one: it keeps its context (fast tab-back) but becomes reclaimable.
    sessions[0].engine.unmount(sessions[0].host as unknown as HTMLElement)
    expect(sessions[0].engine.capabilities.webgl).toBe(true)

    const next = makeSession()
    next.engine.mount(next.host as unknown as HTMLElement)

    expect(next.engine.capabilities.webgl).toBe(true)
    expect(sessions[0].engine.capabilities.webgl).toBe(false)
    expect(FakeWebglAddon.live).toBe(_MAX_WEBGL_CONTEXTS)
  })

  it('re-acquires a context when a reclaimed terminal is shown again', () => {
    const sessions = Array.from({ length: _MAX_WEBGL_CONTEXTS }, makeSession)
    for (const s of sessions) s.engine.mount(s.host as unknown as HTMLElement)

    const parked = sessions[0]
    parked.engine.unmount(parked.host as unknown as HTMLElement)
    const taker = makeSession()
    taker.engine.mount(taker.host as unknown as HTMLElement)
    expect(parked.engine.capabilities.webgl).toBe(false)

    // Show the parked session again; another off-screen terminal yields a slot.
    taker.engine.unmount(taker.host as unknown as HTMLElement)
    parked.engine.mount(parked.host as unknown as HTMLElement)
    expect(parked.engine.capabilities.webgl).toBe(true)
    expect(FakeWebglAddon.live).toBeLessThanOrEqual(_MAX_WEBGL_CONTEXTS)
  })

  it('returns the context to the budget when the GPU drops it', () => {
    const s = makeSession()
    s.engine.mount(s.host as unknown as HTMLElement)
    expect(_webglContextCount()).toBe(1)

    // Simulate Chromium/GPU losing the context (OOM, system suspend).
    const addon = (s.engine as unknown as { webgl: InstanceType<typeof FakeWebglAddon> }).webgl
    addon.onLoss?.()

    // Previously capabilities.webgl stayed true and the slot leaked.
    expect(s.engine.capabilities.webgl).toBe(false)
    expect(_webglContextCount()).toBe(0)
    expect(FakeWebglAddon.live).toBe(0)
  })

  it('frees the context when a session is closed', () => {
    const sessions = Array.from({ length: 4 }, makeSession)
    for (const s of sessions) s.engine.mount(s.host as unknown as HTMLElement)
    expect(_webglContextCount()).toBe(4)

    for (const s of sessions) s.engine.dispose()
    expect(_webglContextCount()).toBe(0)
    expect(FakeWebglAddon.live).toBe(0)
  })

  it('does not stack duplicate contexts when a visible terminal re-mounts', () => {
    const s = makeSession()
    s.engine.mount(s.host as unknown as HTMLElement)
    const afterFirst = FakeWebglAddon.created
    // A re-render can re-run the mount effect without unmounting first.
    s.engine.mount(s.host as unknown as HTMLElement)
    expect(FakeWebglAddon.created).toBe(afterFirst)
    expect(_webglContextCount()).toBe(1)
  })
})
