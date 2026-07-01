import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const NODE = process.execPath
const DATA = '/tmp/crew-analytics-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 10000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')
  const script = "process.stdout.write('Total cost: $5.00\\nReady\\n> '); setInterval(()=>{},1000)"
  const id = await page.evaluate(
    async ({ node, s, cwd }) => (await window.crew.createSession({ presetId: null, command: node, args: ['-e', s], cwd, label: 'Worker' })).id,
    { node: NODE, s: script, cwd: ROOT }
  )
  // let it report cost + go waiting + accrue some waiting time
  await waitUntil(async () => {
    const r = await page.evaluate((sid) => window.crew.getRoster().then((x) => x.find((s) => s.id === sid)), id)
    return r && r.state === 'WAITING_INPUT' && Math.abs(r.costUsd - 5) < 0.001
  }, 'worker waiting + $5 reported')
  await page.waitForTimeout(1500)

  // ---- Analytics ----
  await page.locator('.icon-btn[title="Activity & spend"]').click()
  await page.waitForSelector('.analytics')
  const tableText = await page.locator('.analytics').textContent()
  if ((tableText || '').includes('$5.00')) ok('analytics shows per-session + total spend')
  else bad(`analytics missing spend: ${tableText}`)
  const waitCell = await page.locator('.analytics tbody tr td').nth(1).textContent()
  if (waitCell && waitCell !== '0s') ok(`analytics shows accrued waiting time (${waitCell.trim()})`)
  else bad(`waiting time not tracked: ${waitCell}`)
  const timelineRows = await page.locator('.timeline-row').count()
  if (timelineRows > 0) ok(`activity timeline has ${timelineRows} events`)
  else bad('timeline empty')
  await page.locator('.modal .btn--primary').click()

  // ---- Budget alert ----
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.locator('.settings-num').fill('1')
  await page.locator('.settings-num').dispatchEvent('input')
  await page.locator('.modal .btn--primary').click()
  await waitUntil(async () => (await page.locator('.roster__footer.is-over-budget').count()) === 1, 'budget alert shows')
  ok('over-budget alert shows when total spend exceeds the budget')

  await page.evaluate((sid) => window.crew.closeSession(sid), id)
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ ANALYTICS + BUDGET WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
