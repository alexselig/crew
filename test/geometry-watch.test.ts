import { describe, it, expect, beforeEach } from 'vitest'
import { sampleGeometry, installGeometryWatch } from '../src/renderer/terminal/geometry-watch'

interface FakeCanvas {
  width: number
  height: number
  style: { width: string; height: string }
}

function fakeDoc(canvases: FakeCanvas[], scrollTop = 0): Document {
  return {
    getElementsByTagName: () => canvases,
    querySelector: (sel: string) => (sel === '.xterm-viewport' ? { scrollTop } : null)
  } as unknown as Document
}

function fakeWin(over: Partial<Window> = {}): Window {
  const queue: FrameRequestCallback[] = []
  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 2,
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      queue.push(cb)
      return queue.length
    },
    ...over
  } as unknown as Window
  ;(win as unknown as { __queue: FrameRequestCallback[] }).__queue = queue
  return win
}

const drainFrames = (win: Window, n: number): void => {
  const q = (win as unknown as { __queue: FrameRequestCallback[] }).__queue
  for (let i = 0; i < n; i++) {
    const cb = q.shift()
    if (!cb) return
    cb(i)
  }
}

const canvas = (w: number, h: number, cssW = w / 2, cssH = h / 2): FakeCanvas => ({
  width: w,
  height: h,
  style: { width: `${cssW}px`, height: `${cssH}px` }
})

describe('sampleGeometry', () => {
  it('sums the device-pixel size of every canvas', () => {
    const got = sampleGeometry(fakeDoc([canvas(800, 600), canvas(400, 300)]), fakeWin())
    expect(got.canvasW).toBe(1200)
    expect(got.canvasH).toBe(900)
  })

  it('reads the CSS box from the inline style, not a bounding rect', () => {
    const got = sampleGeometry(fakeDoc([canvas(800, 600, 400, 300)]), fakeWin())
    expect(got.screenW).toBe(400)
    expect(got.screenH).toBe(300)
  })

  it('rounds a fractional CSS size to a whole pixel', () => {
    const c = canvas(800, 600)
    c.style = { width: '399.6px', height: '300.2px' }
    const got = sampleGeometry(fakeDoc([c]), fakeWin())
    expect(got.screenW).toBe(400)
    expect(got.screenH).toBe(300)
  })

  it('survives a document with no terminal at all', () => {
    const got = sampleGeometry(fakeDoc([]), fakeWin())
    expect(got).toMatchObject({ canvasW: 0, canvasH: 0, screenW: 0, screenH: 0, scrollTop: 0 })
  })

  it('reads the viewport scroll offset', () => {
    expect(sampleGeometry(fakeDoc([canvas(10, 10)], 42), fakeWin()).scrollTop).toBe(42)
  })

  it('scales devicePixelRatio to an integer so a scale change is a clean move', () => {
    expect(sampleGeometry(fakeDoc([]), fakeWin({ devicePixelRatio: 1.5 })).dpr).toBe(150)
  })

  it('falls back to a ratio of 1 when the window reports none', () => {
    expect(sampleGeometry(fakeDoc([]), fakeWin({ devicePixelRatio: 0 })).dpr).toBe(100)
  })
})

describe('installGeometryWatch', () => {
  beforeEach(() => {
    delete (globalThis as { __crewGeometryChurn?: unknown }).__crewGeometryChurn
  })

  const churn = (): (() => { frames: number; oscillations: Record<string, number>; reading: string } | null) =>
    (globalThis as unknown as { __crewGeometryChurn: () => never }).__crewGeometryChurn

  it('exposes the probe but counts nothing until the census asks', () => {
    const win = fakeWin()
    installGeometryWatch(fakeDoc([canvas(800, 600)]), win)
    expect(typeof churn()).toBe('function')
    expect((win as unknown as { __queue: unknown[] }).__queue).toHaveLength(0)
  })

  it('starts the loop on the first call and reports nothing yet', () => {
    const win = fakeWin()
    installGeometryWatch(fakeDoc([canvas(800, 600)]), win)
    expect(churn()()).toBeNull()
    expect((win as unknown as { __queue: unknown[] }).__queue).toHaveLength(1)
  })

  it('counts a wobble that a 4 Hz poll would alias away', () => {
    const c = canvas(800, 600)
    const win = fakeWin()
    installGeometryWatch(fakeDoc([c]), win)
    churn()()
    // Twelve frames of the canvas height flipping back and forth: at 250ms the
    // census would see the same value twice and conclude nothing moved.
    for (let i = 0; i < 12; i++) {
      c.height = i % 2 ? 601 : 600
      drainFrames(win, 1)
    }
    const r = churn()()!
    expect(r.frames).toBe(12)
    expect(r.oscillations.canvasH).toBeGreaterThan(8)
    expect(r.reading).toMatch(/canvasH wobbled/)
  })

  it('partitions consecutive reads rather than reporting a growing total', () => {
    const c = canvas(800, 600)
    const win = fakeWin()
    installGeometryWatch(fakeDoc([c]), win)
    churn()()
    for (let i = 0; i < 6; i++) {
      c.height = i % 2 ? 601 : 600
      drainFrames(win, 1)
    }
    const first = churn()()!
    drainFrames(win, 3)
    const second = churn()()!
    expect(first.frames).toBe(6)
    expect(second.frames).toBe(3)
    expect(second.oscillations.canvasH).toBe(0)
  })

  it('does not call a one-way resize a wobble', () => {
    const c = canvas(800, 600)
    const win = fakeWin()
    installGeometryWatch(fakeDoc([c]), win)
    churn()()
    drainFrames(win, 4)
    c.height = 700
    drainFrames(win, 6)
    const r = churn()()!
    expect(r.oscillations.canvasH).toBe(0)
    expect(r.reading).toMatch(/one-way resize, not a wobble/)
  })

  it('reads as still when the geometry holds still', () => {    const win = fakeWin()
    installGeometryWatch(fakeDoc([canvas(800, 600)]), win)
    churn()()
    drainFrames(win, 20)
    expect(churn()()!.reading).toMatch(/held still across 20 frames/)
  })

  it('never installs twice over an existing probe', () => {
    const win = fakeWin()
    installGeometryWatch(fakeDoc([canvas(800, 600)]), win)
    const first = churn()
    installGeometryWatch(fakeDoc([canvas(10, 10)]), fakeWin())
    expect(churn()).toBe(first)
  })

  it('keeps sampling when a frame throws, because diagnostics must not crash the app', () => {
    const win = fakeWin()
    const doc = {
      getElementsByTagName: () => {
        throw new Error('detached')
      },
      querySelector: () => null
    } as unknown as Document
    installGeometryWatch(doc, win)
    churn()()
    expect(() => drainFrames(win, 3)).not.toThrow()
    expect(churn()()!.frames).toBe(0)
  })
})
