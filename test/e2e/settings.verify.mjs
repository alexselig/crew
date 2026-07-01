import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-settings-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  await page.locator('.icon-btn[title="Settings"]').click()
  await page.waitForSelector('.settings-row')
  ok('settings modal opens')
  const before = await page.evaluate(() => window.crew.getSettings().then((s) => s.notifications))
  await page.locator('.settings-row', { hasText: 'Notifications' }).first().click()
  await waitUntil(
    async () => (await page.evaluate(() => window.crew.getSettings().then((s) => s.notifications))) !== before,
    'notifications toggled'
  )
  ok(`toggled notifications ${before} -> ${!before} (persisted via IPC)`)

  // reopen to confirm it stuck
  await page.locator('.modal .btn--primary').click()
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.waitForSelector('.settings-row')
  const persisted = await page.evaluate(() => window.crew.getSettings().then((s) => s.notifications))
  if (persisted === !before) ok('setting persisted across reopen')
  else bad('setting did not persist')

  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ SETTINGS WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
