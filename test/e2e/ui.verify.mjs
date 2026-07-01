// Verifies the roster/grid/skills features deterministically:
//  - stable nav order (no auto-reshuffle when a session needs input)
//  - "Needs you" buttons
//  - single/grid view toggle, live grid tiles, needs-you-first ordering, expand
//  - drag-to-reorder
//  - skills picker: minimized chip → gallery → preview → invoke ("use <skill> to ")
// Run: node test/e2e/ui.verify.mjs

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-ui'
mkdirSync(SHOTS, { recursive: true })
const ROOT = resolve('/Users/alexselig/crew')
const HOME = process.env.HOME || ROOT
const NODE_BIN = process.execPath
const DATA_DIR = '/tmp/crew-ui-data'

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}
async function waitUntil(fn, desc, timeout = 12000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timeout: ${desc}`)
}
const texts = (page, sel) => page.locator(sel).allTextContents()

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page = await app.firstWindow()
  const rendererErrors = []
  page.on('pageerror', (e) => rendererErrors.push(String(e)))
  await page.waitForSelector('.app', { timeout: 10000 })

  // Two always-busy agents + one that goes to "needs you" — fully deterministic.
  console.log('▶ create One (busy), Two (busy), Ask (waits)')
  await page.evaluate(
    async ({ node, home, root }) => {
      const busy = 'setInterval(()=>process.stdout.write("."),300)'
      await window.crew.createSession({ presetId: null, command: node, args: ['-e', busy], cwd: root, label: 'One' })
      await window.crew.createSession({
        presetId: null,
        command: node,
        args: ['-e', 'process.stdout.write("Total cost: $0.42\\n"); ' + busy],
        cwd: root,
        label: 'Two'
      })
      await window.crew.createSession({
        presetId: null,
        command: node,
        args: ['-e', "process.stdout.write('question?\\n> '); setInterval(()=>{},1000)"],
        cwd: home,
        label: 'Ask'
      })
    },
    { node: NODE_BIN, home: HOME, root: ROOT }
  )
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 3, 'three cards')
  ok('three sessions created')

  // ---- Needs-you buttons + stable order ----
  console.log('\n▶ needs-you buttons + stable nav order')
  await waitUntil(
    async () => (await texts(page, '.needs-you__name')).includes('Ask'),
    'Ask shows up under "Needs you"'
  )
  ok('"Needs you" button appears for Ask')
  const navOrder = await texts(page, '.roster__list .card__label')
  if (JSON.stringify(navOrder) === JSON.stringify(['One', 'Two', 'Ask'])) {
    ok('nav order stayed One/Two/Ask (no auto-reshuffle when Ask needs input)')
  } else {
    bad(`nav reordered unexpectedly: ${JSON.stringify(navOrder)}`)
  }
  await page.screenshot({ path: join(SHOTS, '01-single-needsyou.png') })

  // ---- Per-session + total spend ----
  console.log('\n▶ spend tracking')
  await waitUntil(async () => {
    const r = await page.evaluate(() => window.crew.getRoster())
    const two = r.find((s) => s.label === 'Two')
    return two && Math.abs(two.costUsd - 0.42) < 0.001
  }, 'Two reports $0.42', 8000)
  ok('parsed reported spend for Two ($0.42)')
  const twoCard = await page.locator('.card:has-text("Two") .card__cost').textContent()
  if ((twoCard || '').includes('$0.42')) ok('card shows the per-session cost ($0.42)')
  else bad(`card cost wrong: ${twoCard}`)
  const total = await page.locator('.roster__footer-total').textContent()
  if ((total || '').includes('$0.42')) ok(`nav footer shows total spend (${total})`)
  else bad(`total spend wrong: ${total}`)

  // ---- Grid view ----
  console.log('\n▶ grid view')
  await page.locator('.view-toggle__btn').nth(1).click()
  await waitUntil(async () => (await page.locator('.tile').count()) === 3, 'three tiles')
  ok('grid shows a tile per session')
  const tileOrder = await texts(page, '.tile__label')
  if (tileOrder[0] === 'Ask') ok('grid floats the needs-you session (Ask) to the top')
  else bad(`grid did not prioritize needs-you: ${JSON.stringify(tileOrder)}`)
  if ((await page.locator('.tile .xterm').count()) === 3) ok('each tile hosts a live terminal')
  else bad('tiles missing live terminals')
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(SHOTS, '02-grid.png') })

  await page.locator('.tile:has-text("One") .mini-btn--icon').click()
  await waitUntil(async () => (await page.locator('.session-view .term-mount').count()) === 1, 'back to single')
  ok('tile expand returns to focus view')

  // ---- Needs-you button → focus that session ----
  console.log('\n▶ needs-you button → focus')
  await page.locator('.needs-you__btn:has-text("Ask")').click()
  await waitUntil(
    async () => (await page.locator('.session-header__label').textContent().catch(() => '')) === 'Ask',
    'focus view shows Ask'
  )
  ok('needs-you button opens Ask in focus view')

  // ---- Skills picker ----
  console.log('\n▶ skills picker')
  const toggle = page.locator('.skill-chip--toggle')
  if (((await toggle.textContent()) || '').includes('Skills')) ok('minimized "Skills" chip present')
  else bad('no minimized Skills chip')
  await toggle.click() // expand gallery
  await waitUntil(async () => (await page.locator('.skills-bar__chips .skill-chip').count()) > 5, 'gallery opens')
  ok(`gallery shows ${await page.locator('.skills-bar__chips .skill-chip').count()} skill chips`)

  const ship = page.locator('.skills-bar__chips .skill-chip').filter({ hasText: /^Ship/ }).first()
  await ship.click() // first click → description
  await waitUntil(
    async () => ((await page.locator('.skills-bar__desc').textContent().catch(() => '')) || '').includes('ship'),
    'description preview appears'
  )
  ok('first click previews the skill description')
  await page.screenshot({ path: join(SHOTS, '03-skills-gallery.png') })

  await ship.click() // second click → invoke
  await waitUntil(
    async () => ((await page.locator('.session-body .xterm-rows').textContent().catch(() => '')) || '').includes('use ship to'),
    'invocation typed into the session'
  )
  ok('second click types "use ship to " into the session')
  await page.screenshot({ path: join(SHOTS, '04-skill-invoked.png') })

  // ---- Drag reorder ----
  console.log('\n▶ drag to reorder')
  const before = await texts(page, '.roster__list .card__label')
  await page
    .locator('.roster__list .card:has-text("One")')
    .dragTo(page.locator('.roster__list .card:has-text("Ask")'))
  await page.waitForTimeout(500)
  const after = await texts(page, '.roster__list .card__label')
  if (JSON.stringify(after) !== JSON.stringify(before) && after.indexOf('One') > after.indexOf('Two')) {
    ok(`drag reordered: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  } else {
    bad(`drag did not reorder: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  }

  // ---- Resize + collapse sidebar ----
  console.log('\n▶ resize + collapse sidebar')
  const w0 = (await page.locator('.roster').boundingBox()).width
  const hb = await page.locator('.roster__resize').boundingBox()
  await page.mouse.move(hb.x + 3, hb.y + 140)
  await page.mouse.down()
  await page.mouse.move(hb.x + 140, hb.y + 140, { steps: 8 })
  await page.mouse.up()
  const w1 = (await page.locator('.roster').boundingBox()).width
  if (w1 > w0 + 40) ok(`sidebar resized ${Math.round(w0)}px → ${Math.round(w1)}px`)
  else bad(`resize had no effect: ${Math.round(w0)} → ${Math.round(w1)}`)

  await page.locator('.icon-btn[title="Collapse sidebar"]').click()
  await waitUntil(async () => (await page.locator('.roster--collapsed').count()) === 1, 'collapsed')
  if ((await page.locator('.card--compact').count()) === 3) ok('collapsed rail shows compact icon cards')
  else bad('compact cards missing in collapsed rail')
  if (await page.locator('.card__cname').first().textContent()) ok('session name shown under the icon')
  const railW = (await page.locator('.roster').boundingBox()).width
  if (railW < 110) ok(`collapsed rail is narrow (${Math.round(railW)}px)`)
  else bad(`collapsed rail too wide: ${Math.round(railW)}px`)
  await page.screenshot({ path: join(SHOTS, '05-collapsed.png') })
  await page.locator('.icon-btn[title="Expand sidebar"]').click()
  await waitUntil(async () => (await page.locator('.roster--collapsed').count()) === 0, 'expanded')
  ok('expand restores the full sidebar')

  await page.evaluate(async () => {
    const r = await window.crew.getRoster()
    for (const s of r) await window.crew.closeSession(s.id)
  })
  await app.close()
  rmSync(DATA_DIR, { recursive: true, force: true })

  console.log('\n================ UI VERIFY ================')
  console.log(`renderer errors: ${rendererErrors.length}`)
  rendererErrors.forEach((e) => console.log('   ! ' + e))
  console.log(`failures: ${failures}`)
  console.log(failures || rendererErrors.length ? '\n❌ FAILED' : '\n✅ UI FEATURES WORK')
  process.exit(failures || rendererErrors.length ? 1 : 0)
}

main().catch((e) => {
  console.error('💥 harness error:', e)
  process.exit(1)
})
