import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-bcast-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 9000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
async function selectAndRead(page, label) {
  await page.locator(`.roster__list .card:has-text("${label}")`).click()
  await page.waitForTimeout(300)
  return (await page.locator('.session-body .xterm-rows').textContent().catch(() => '')) || ''
}

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')
  await page.evaluate(({ cwd }) => {
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Alpha' })
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Bravo' })
  }, { cwd: ROOT })
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 2, 'two sessions')

  // ---- Broadcast ----
  await page.locator('.icon-btn[title="Broadcast a prompt"]').click()
  await page.waitForSelector('.bcast-list')
  await page.locator('.modal textarea').fill('echo HELLO_BCAST')
  await page.locator('.modal .btn--primary').click()
  const aOut = await selectAndRead(page, 'Alpha')
  const bOut = await selectAndRead(page, 'Bravo')
  if (aOut.includes('HELLO_BCAST') && bOut.includes('HELLO_BCAST')) ok('broadcast reached both sessions')
  else bad(`broadcast missed a session (A=${aOut.includes('HELLO_BCAST')}, B=${bOut.includes('HELLO_BCAST')})`)

  // ---- Save + launch a project set ----
  await page.keyboard.press('Meta+n')
  await page.waitForSelector('.sets')
  await page.locator('.sets__save .field__input').fill('MySet')
  await page.locator('.sets__save .btn').click()
  await waitUntil(async () => {
    const sets = await page.evaluate(() => window.crew.getSets())
    return sets.some((s) => s.name === 'MySet' && s.sessions.length === 2)
  }, 'set saved with 2 sessions')
  ok('saved current sessions as a set (2 sessions)')

  await page.locator('.set-chip__launch:has-text("MySet")').click() // launches + closes modal
  await waitUntil(async () => (await page.evaluate(() => window.crew.getRoster().then((r) => r.length))) === 4, 'set launched (2 more sessions)')
  ok('launching the set spawned its sessions (roster 2 → 4)')

  await page.evaluate(async () => { const r = await window.crew.getRoster(); for (const s of r) await window.crew.closeSession(s.id) })
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ BROADCAST + SETS WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
