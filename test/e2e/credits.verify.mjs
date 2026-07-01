import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const NODE = process.execPath
const DATA = '/tmp/crew-credits-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 8000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
const footer = (page) => page.locator('.roster__footer-total').textContent().catch(() => '')

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  const script = "process.stdout.write('Total cost: $0.42\\nSession: 7 AIC used\\n'); setInterval(()=>{},1000)"
  const id = await page.evaluate(
    async ({ node, s, cwd }) => (await window.crew.createSession({ presetId: null, command: node, args: ['-e', s], cwd, label: 'Meter' })).id,
    { node: NODE, s: script, cwd: ROOT }
  )
  await waitUntil(async () => {
    const r = await page.evaluate((sid) => window.crew.getRoster().then((x) => x.find((s) => s.id === sid)), id)
    return r && Math.abs(r.costUsd - 0.42) < 0.001 && r.creditsUsed === 7
  }, 'cost $0.42 + 7 credits parsed', 8000)
  ok('parsed reported spend ($0.42) and credits (7 AIC)')

  // default: spend shown, credits hidden
  let f = await footer(page)
  if (f.includes('$0.42') && !/cr/.test(f)) ok(`footer shows spend only by default (${f.trim()})`)
  else bad(`unexpected default footer: ${f}`)

  // toggle "Show credits used" on
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.locator('.settings-row', { hasText: 'Show credits used' }).click()
  await page.locator('.modal .btn--primary').click()
  await waitUntil(async () => /cr/.test(await footer(page)), 'credits appear after toggle')
  f = await footer(page)
  if (f.includes('7') && f.includes('cr')) ok(`footer now shows credits (${f.trim()})`)
  else bad(`credits not shown: ${f}`)

  // toggle "Show spend" off
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.locator('.settings-row', { hasText: 'Show spend' }).click()
  await page.locator('.modal .btn--primary').click()
  await waitUntil(async () => !(await footer(page)).includes('$'), 'spend hidden after toggle')
  f = await footer(page)
  if (!f.includes('$') && f.includes('cr')) ok(`spend hidden, credits remain (${f.trim()})`)
  else bad(`toggle-off spend failed: ${f}`)

  await page.evaluate((sid) => window.crew.closeSession(sid), id)
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ SPEND/CREDITS TOGGLES WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
