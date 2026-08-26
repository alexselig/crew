// Verifies the WebGL context budget in a REAL Electron renderer — the flicker
// fix. Chromium caps active WebGL contexts per renderer (16) and force-loses
// the OLDEST one past that, logging:
//   "WARNING: Too many active WebGL contexts. Oldest context will be lost."
// Each such eviction repaints whichever terminal owned that context, which is
// what the user saw as a flash in an unrelated pane — worsening the longer Crew
// ran, because a context taken on first mount was never given back.
//
// This walks a roster far larger than the cap through the enhanced terminal and
// asserts (a) Chromium never has to evict anything, and (b) Crew's own live
// context count stays within its budget.
//
// Run: node test/e2e/webgl-budget.verify.mjs

import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const NODE_BIN = process.execPath
const DATA_DIR = '/tmp/crew-webgl-data'
// Comfortably past Chromium's 16-context cap: the old code would have taken a
// context for every one of these and started evicting a third of the way in.
const SESSIONS = 24

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
async function waitUntil(fn, desc, timeout = 20000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timeout: ${desc}`)
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page = await app.firstWindow()

  // Chromium reports context eviction on the console; that message IS the bug.
  const evictions = []
  page.on('console', (m) => {
    const t = m.text()
    if (/Too many active WebGL contexts/i.test(t)) evictions.push(t)
  })
  const rendererErrors = []
  page.on('pageerror', (e) => rendererErrors.push(String(e)))

  await page.waitForSelector('.app', { timeout: 15000 })

  // The budget only applies to the Crew engine, so turn it on explicitly. The
  // renderer picks the engine up from settings at load, so reload after writing
  // them — otherwise the app stays on the legacy pool and this test would pass
  // vacuously, never taking a WebGL context at all.
  console.log('▶ enable the enhanced terminal')
  await page.evaluate(async () => {
    await window.crew.updateSettings({ enhancedTerminal: true })
  })
  await page.reload()
  await page.waitForSelector('.app', { timeout: 15000 })
  const enhanced = await page.evaluate(() => window.crew.getSettings().then((s) => !!s.enhancedTerminal))
  if (enhanced) ok('enhanced terminal is on')
  else bad('enhanced terminal did NOT turn on — the rest of this test would be vacuous')

  await waitUntil(
    async () => (await page.evaluate(() => window.__crewWebglBudget)) !== undefined,
    'engine module loaded'
  )
  const budget = await page.evaluate(() => window.__crewWebglBudget)
  if (budget > 0 && budget < 16) ok(`budget is ${budget}, under Chromium's 16-context cap`)
  else bad(`budget ${budget} is not a safe value under the 16-context cap`)

  console.log(`\n▶ create ${SESSIONS} sessions`)
  await page.evaluate(
    async ({ node, root, n }) => {
      const busy = 'setInterval(()=>process.stdout.write("."),400)'
      for (let i = 0; i < n; i++) {
        await window.crew.createSession({
          presetId: null,
          command: node,
          args: ['-e', busy],
          cwd: root,
          label: `S${i}`
        })
      }
    },
    { node: NODE_BIN, root: ROOT, n: SESSIONS }
  )
  await waitUntil(
    async () => (await page.locator('.roster__list .card').count()) >= SESSIONS,
    `${SESSIONS} cards`
  )
  ok(`${SESSIONS} sessions created`)

  // Walk the whole roster, showing each session in turn. Every one of these
  // mounts a terminal — the exact action that used to take a context forever.
  console.log('\n▶ view every session in turn')
  const ids = await page.evaluate(() => window.crew.getRoster().then((r) => r.map((s) => s.id)))
  let peak = 0
  for (const id of ids) {
    await page.locator(`.roster__list .card[data-session-id="${id}"]`).first().click()
    await page.waitForTimeout(120)
    const live = await page.evaluate(() => window.__crewWebglContexts?.() ?? -1)
    if (live > peak) peak = live
  }
  ok(`walked ${ids.length} sessions; peak live WebGL contexts = ${peak}`)
  console.log(`    evictions after walk: ${evictions.length}`)
  const afterWalk = evictions.length

  // Guard against a vacuous pass: if nothing was ever accelerated, "under
  // budget" proves nothing about the fix.
  if (peak > 0) ok('terminals really are WebGL-accelerated (the budget is being exercised)')
  else bad('no terminal ever took a WebGL context — this run proves nothing')

  if (peak <= budget) ok(`never exceeded the budget of ${budget}`)
  else bad(`peak ${peak} exceeded the budget of ${budget}`)

  // Also exercise grid view, which mounts several terminals at once.
  console.log('\n▶ grid view (many terminals mounted at once)')
  await page.locator('.view-toggle__btn').nth(1).click()
  await page.waitForTimeout(2000)
  const gridLive = await page.evaluate(() => window.__crewWebglContexts?.() ?? -1)
  const tiles = await page.locator('.tile').count()
  console.log(`    tiles mounted: ${tiles}, evictions after grid: ${evictions.length} (walk had ${afterWalk})`)
  if (gridLive <= budget) ok(`grid view holds ${gridLive} contexts, within budget`)
  else bad(`grid view holds ${gridLive} contexts, over budget ${budget}`)

  // The headline assertion: Chromium never had to throw a context away, so no
  // terminal was ever forced to repaint behind the user's back.
  if (evictions.length === 0) ok('Chromium never force-lost a WebGL context (no flicker trigger)')
  else bad(`Chromium evicted contexts ${evictions.length}x: ${evictions[0]}`)

  if (rendererErrors.length) bad(`renderer errors: ${rendererErrors.join(' | ')}`)
  else ok('no renderer errors')

  await app.close()
  console.log(failures === 0 ? '\nPASS — 0 failures' : `\nFAIL — ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
