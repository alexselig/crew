import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-groups-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 9000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
const launch = () => electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  let app = await launch()
  let page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')
  const ids = await page.evaluate(({ cwd }) => Promise.all([
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Aye' }),
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Bee' }),
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Cee' })
  ]).then((r) => r.map((x) => x.id)), { cwd: ROOT })
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 3, 'three cards')

  // set Aye's tag via the header tag chip UI (Aye is selected by default)
  await page.locator('.roster__list .card:has-text("Aye")').click()
  await page.locator('.tag-chip').click()
  await page.locator('.tag-chip--input').fill('proj1')
  await page.keyboard.press('Enter')
  await waitUntil(async () => ((await page.locator('.tag-chip').textContent()) || '').includes('proj1'), 'tag set via UI')
  ok('set a tag from the session header')

  // set Bee/Cee via API
  await page.evaluate(([b, c]) => Promise.all([window.crew.setTag(b, 'proj1'), window.crew.setTag(c, 'proj2')]), [ids[1], ids[2]])
  await page.waitForTimeout(300)

  // enable grouping by group via the group picker dropdown
  await page.locator('.group-picker .icon-btn').click()
  await page.locator('.group-menu__item', { hasText: 'By group' }).click()
  await waitUntil(async () => (await page.locator('.roster__list .group').count()) === 2, 'two groups')
  const names = await page.locator('.roster__list .group__name').allTextContents()
  if (names.includes('proj1') && names.includes('proj2')) ok(`nav grouped by group: ${JSON.stringify(names)}`)
  else bad(`unexpected groups: ${JSON.stringify(names)}`)

  // the grid view mirrors the same grouping (shared grouping state)
  await page.locator('.view-toggle__btn').nth(1).click()
  await waitUntil(async () => (await page.locator('.grid-group').count()) === 2, 'grid shows 2 groups')
  const gnames = await page.locator('.grid-group__name').allTextContents()
  if (gnames.includes('proj1') && gnames.includes('proj2')) ok(`grid grouped by group: ${JSON.stringify(gnames)}`)
  else bad(`grid groups unexpected: ${JSON.stringify(gnames)}`)
  await page.locator('.roster__collapsed-head .icon-btn[title="Switch to focus view"]').click()
  await waitUntil(async () => (await page.locator('.roster:not(.roster--collapsed)').count()) === 1, 'nav expanded')

  // collapse proj1 (2 sessions) → visible cards drop to 1
  await page.locator('.group__header:has-text("proj1")').click()
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 1, 'group collapsed')
  ok('collapsing a group hides its sessions')
  await app.close()

  // relaunch → tags + grouping persist
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.app')
  await waitUntil(async () => (await page.locator('.group').count()) === 2, 'groups persisted', 12000)
  const r = await page.evaluate(() => window.crew.getRoster())
  const tags = r.map((s) => s.tag).sort()
  if (JSON.stringify(tags) === JSON.stringify(['proj1', 'proj1', 'proj2'])) ok('tags persisted across relaunch')
  else bad(`tags not persisted: ${JSON.stringify(tags)}`)

  // switch to the "Needs you" grouping mode
  await page.locator('.group-picker .icon-btn').click()
  await page.locator('.group-menu__item', { hasText: 'Needs you' }).click()
  await waitUntil(async () => (await page.locator('.group__name:has-text("Needs you")').count()) === 1, 'needs-you group')
  ok('“Needs you” is a grouping option')
  if ((await page.locator('.needs-you').count()) === 0) ok('old pinned "Needs you" section is gone')
  else bad('pinned needs-you section still present')

  await page.evaluate(async () => { const x = await window.crew.getRoster(); for (const s of x) await window.crew.closeSession(s.id) })
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ GROUPS / TAGS WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
