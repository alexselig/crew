/**
 * Frame-rate geometry sampling for the flicker census.
 *
 * The structural census samples four times a second from the main process. The
 * 7 Oct capture showed it recording almost nothing while the user watched the
 * screen jitter, which rules out mount/renderer churn — but a 4 Hz poll also
 * cannot see a wobble that happens every frame, because the wobble aliases into
 * the sample interval. So the counting happens here, at frame rate, and the
 * census reads an accumulated total instead of an instantaneous value.
 *
 * Idle until asked. The rAF loop starts on the census's first call and stops
 * when the window hides, so a normal run pays nothing for it.
 *
 * What is read each frame is chosen to avoid forcing layout: canvas `width`
 * and `height` are plain attributes, and the CSS box is read from the inline
 * style xterm already set, not from a bounding rect. Measuring must not change
 * what it measures. `scrollTop` is the one exception, and it is free unless
 * layout is already dirty — in which case that dirtiness is itself the finding.
 */

import {
  createChurnAccumulator,
  interpretChurn,
  type ChurnReport,
  type GeometrySample
} from '../../shared/geometry-churn'

const px = (v: string): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? Math.round(n) : 0
}

/** Read the geometry whose movement would be visible as jitter. */
export function sampleGeometry(doc: Document, win: Window): GeometrySample {
  const canvases = doc.getElementsByTagName('canvas')
  let canvasW = 0
  let canvasH = 0
  for (let i = 0; i < canvases.length; i++) {
    canvasW += canvases[i].width
    canvasH += canvases[i].height
  }
  const first = canvases[0]
  const viewport = doc.querySelector('.xterm-viewport')
  return {
    canvasW,
    canvasH,
    screenW: first ? px(first.style.width) : 0,
    screenH: first ? px(first.style.height) : 0,
    scrollTop: viewport ? Math.round(viewport.scrollTop) : 0,
    winW: Math.round(win.innerWidth),
    winH: Math.round(win.innerHeight),
    dpr: Math.round((win.devicePixelRatio || 1) * 100)
  }
}

interface ChurnGlobal {
  __crewGeometryChurn?: () => (ChurnReport & { reading: string }) | null
}

/**
 * Expose `__crewGeometryChurn()` to the census.
 *
 * Each call returns everything counted since the previous call and resets, so
 * consecutive census ticks partition the capture rather than reporting a total
 * that only ever grows. The first call starts the loop and returns null,
 * because there is nothing to report yet.
 */
export function installGeometryWatch(doc: Document, win: Window): void {
  const g = globalThis as ChurnGlobal
  if (g.__crewGeometryChurn) return
  const acc = createChurnAccumulator()
  // Per-install, so the loop state cannot leak between windows or tests.
  let running = false

  const tick = (): void => {
    if (!running) return
    try {
      acc.add(sampleGeometry(doc, win))
    } catch {
      /* diagnostics must never be able to take the app down */
    }
    win.requestAnimationFrame(tick)
  }

  g.__crewGeometryChurn = () => {
    if (!running) {
      running = true
      win.requestAnimationFrame(tick)
      return null
    }
    const report = acc.report()
    acc.reset()
    return { ...report, reading: interpretChurn(report) }
  }
}
