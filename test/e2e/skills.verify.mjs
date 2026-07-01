import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-skills-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
const launch = () => electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
async function openSkills(page) {
  await page.locator('.skill-chip--toggle').click()
  await page.waitForSelector('.skills-bar__chips')
}

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  let app = await launch()
  let page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')
  await page.evaluate(({ cwd }) => window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Sh' }), { cwd: ROOT })
  await page.waitForSelector('.xterm')

  await openSkills(page)
  // add a custom skill
  await page.locator('.skill-chip--add').click()
  await page.locator('.skill-add__input').nth(0).fill('Prodpush')
  await page.locator('.skill-add__input').nth(1).fill('prodpush')
  await page.locator('.skill-add__input').nth(2).fill('Ship it to prod')
  await page.locator('.skill-add .btn--primary').click()
  await waitUntil(async () => (await page.locator('.skills-bar__chips .skill-chip', { hasText: 'Prodpush' }).count()) > 0, 'custom skill added')
  ok('added a custom skill "Prodpush"')

  // favorite it → should pin to the front
  await page.locator('.skills-bar__chips .skill-chip', { hasText: 'Prodpush' }).first().click() // arm → shows desc
  await page.locator('.skills-bar__desc .icon-btn[title="Favorite"]').click()
  await waitUntil(async () => {
    const first = await page.locator('.skills-bar__chips .skill-chip').first().textContent()
    return (first || '').includes('Prodpush')
  }, 'favorite pins to front')
  ok('favoriting pins the skill to the front')

  // invoke it
  await page.locator('.skills-bar__chips .skill-chip', { hasText: 'Prodpush' }).first().click() // 2nd click → invoke
  await waitUntil(async () => ((await page.locator('.session-body .xterm-rows').textContent()) || '').includes('use prodpush to'), 'invoke typed into session')
  ok('invoking types "use prodpush to " into the session')
  await app.close()

  // relaunch → custom skill + favorite persist
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.app')
  await waitUntil(async () => (await page.locator('.xterm').count()) > 0, 'session restored')
  await openSkills(page)
  const firstChip = await page.locator('.skills-bar__chips .skill-chip').first().textContent()
  if ((firstChip || '').includes('Prodpush')) ok('custom skill + favorite persisted across relaunch')
  else bad(`did not persist: first chip = ${firstChip}`)

  await page.evaluate(async () => { const r = await window.crew.getRoster(); for (const s of r) await window.crew.closeSession(s.id) })
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ EDITABLE SKILLS + FAVORITES WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
