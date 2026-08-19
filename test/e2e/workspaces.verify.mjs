import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-workspaces-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 9000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
const launch = () => electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await launch()
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  // Three sessions: two tagged "Alpha", one tagged "Beta". All start archived
  // (in no workspace), so the Archived lane will show group sub-headers.
  const ids = await page.evaluate(({ cwd }) => Promise.all([
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Aye' }),
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Bee' }),
    window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Cee' })
  ]).then((r) => r.map((x) => x.id)), { cwd: ROOT })
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 3, 'three cards')
  await page.evaluate(([a, b, c]) => Promise.all([
    window.crew.setTag(a, 'Alpha'), window.crew.setTag(b, 'Alpha'), window.crew.setTag(c, 'Beta')
  ]), ids)
  // A destination workspace to receive a dragged group.
  await page.evaluate(() => window.crew.createWorkspace('Client Work'))
  await page.waitForTimeout(300)

  // Open the Workspace Manager (as the File › Workspaces… menu does).
  await app.evaluate(({ BrowserWindow }, ch) => {
    BrowserWindow.getAllWindows()[0].webContents.send(ch)
  }, 'evt:openWorkspaces')
  await page.waitForSelector('.workspace-manager')
  ok('opened the Workspace Manager')

  // (1) Title clears the traffic lights: the eyebrow's top must sit below the
  // lights (which span ~y18–34 with trafficLightPosition y:18).
  const eyebrowTop = await page.locator('.workspace-manager__eyebrow').evaluate((el) => el.getBoundingClientRect().top)
  if (eyebrowTop >= 34) ok(`header clears traffic lights (eyebrow top=${Math.round(eyebrowTop)}px)`)
  else bad(`header still under the traffic lights (eyebrow top=${Math.round(eyebrowTop)}px)`)

  // (2) Default sort is "group": the Archived lane shows Alpha + Beta sub-heads.
  const sortValue = await page.locator('.workspace-manager__sort-select').inputValue()
  if (sortValue === 'group') ok('sort defaults to "group"')
  else bad(`sort default was "${sortValue}", expected "group"`)
  const archived = page.locator('.workspace-lane--archived')
  await waitUntil(async () => (await archived.locator('.workspace-lane__group-head').count()) === 2, 'two group sub-heads')
  const heads = await archived.locator('.workspace-lane__group-name').allTextContents()
  if (heads.includes('Alpha') && heads.includes('Beta')) ok(`lane grouped by tag: ${JSON.stringify(heads)}`)
  else bad(`unexpected group heads: ${JSON.stringify(heads)}`)

  // Switch sort to "recent": groups collapse into a single flat list (no sub-heads).
  await page.locator('.workspace-manager__sort-select').selectOption('recent')
  await waitUntil(async () => (await archived.locator('.workspace-lane__group-head').count()) === 0, 'flat when recent')
  ok('sort control switches lanes to a flat list')
  // Back to group for the drag test.
  await page.locator('.workspace-manager__sort-select').selectOption('group')
  await waitUntil(async () => (await archived.locator('.workspace-lane__group-head').count()) === 2, 'grouped again')

  // (3) Drag the whole "Alpha" group header onto the "Client Work" lane →
  // BOTH Alpha sessions join it (copy by default; Beta stays put).
  const dest = page.locator('.workspace-lane:not(.workspace-lane--archived)')
  await archived.locator('.workspace-lane__group-head:has-text("Alpha")').dragTo(dest.locator('.workspace-lane__body'))
  await waitUntil(async () => (await dest.locator('.workspace-card').count()) === 2, 'both Alpha sessions moved')
  const destCards = await dest.locator('.workspace-card .workspace-card__name').allTextContents()
  if (destCards.includes('Aye') && destCards.includes('Bee')) ok(`group drag copied all its sessions: ${JSON.stringify(destCards)}`)
  else bad(`destination has unexpected cards: ${JSON.stringify(destCards)}`)

  if (errs.length) bad('page errors: ' + errs.join(' | '))
  await app.close()
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
  console.log('\nAll workspace-manager checks passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
