// Attaches to a running Crew via CDP and measures what the renderer is actually
// doing: heap, live WebGL contexts, canvas/DOM counts, and dropped frames.
// Run Crew with --remote-debugging-port=9333 first.
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP(process.argv[2], { timeout: 120000 })
const ctx = browser.contexts()[0]
const pages = ctx.pages()
console.log('pages:', pages.length)
const page = pages.find((p) => !p.url().startsWith('devtools://')) ?? pages[0]
console.log('url:', page.url())

const evictions = []
page.on('console', (m) => {
  const t = m.text()
  if (/WebGL|context/i.test(t)) evictions.push(t)
})

const snap = async () =>
  page.evaluate(() => {
    const mem = performance.memory ?? {}
    return {
      heapMB: Math.round((mem.usedJSHeapSize ?? 0) / 1e6),
      heapLimitMB: Math.round((mem.jsHeapSizeLimit ?? 0) / 1e6),
      webglContexts: window.__crewWebglContexts?.() ?? null,
      webglBudget: window.__crewWebglBudget ?? null,
      canvases: document.querySelectorAll('canvas').length,
      xtermScreens: document.querySelectorAll('.xterm-screen').length,
      domNodes: document.querySelectorAll('*').length,
      rows: document.querySelectorAll('.xterm-rows > div').length
    }
  })

console.log('--- snapshot A ---')
console.log(await snap())

// Sample frame pacing: anything much over 16.7ms is a dropped frame, which is
// what "flicker" looks like from the outside.
const frames = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const gaps = []
      let last = performance.now()
      let n = 0
      const tick = (t) => {
        gaps.push(t - last)
        last = t
        if (++n < 180) requestAnimationFrame(tick)
        else resolve(gaps)
      }
      requestAnimationFrame(tick)
    })
)
const sorted = [...frames].sort((a, b) => a - b)
const pct = (p) => Math.round(sorted[Math.floor(sorted.length * p)] * 10) / 10
console.log('--- frame pacing over ~3s ---')
console.log({
  frames: frames.length,
  medianMs: pct(0.5),
  p90Ms: pct(0.9),
  p99Ms: pct(0.99),
  worstMs: Math.round(sorted[sorted.length - 1]),
  droppedOver33ms: frames.filter((g) => g > 33).length,
  droppedOver100ms: frames.filter((g) => g > 100).length
})

await new Promise((r) => setTimeout(r, 5000))
console.log('--- snapshot B (5s later) ---')
console.log(await snap())
console.log('webgl/context console messages:', evictions.slice(0, 8))

await browser.close()
