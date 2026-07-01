import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-agents-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  const agents = await page.evaluate(() => window.crew.detectAgents())
  const copilot = agents.find((a) => a.presetId === 'copilot-cli')
  const shell = agents.find((a) => a.presetId === 'shell')
  if (copilot && copilot.available && copilot.path) ok(`detected Copilot CLI at ${copilot.path}`)
  else bad(`copilot not detected: ${JSON.stringify(copilot)}`)
  if (shell && shell.available) ok('detected Shell')
  else bad('shell not detected')
  // every status carries an installHint field for the missing case
  const claude = agents.find((a) => a.presetId === 'claude-code')
  if (claude && typeof claude.installHint === 'string') ok('presets carry install hints for the missing case')
  else bad('missing install hint')

  await page.keyboard.press('Meta+n')
  await page.waitForSelector('.agent-status')
  const statusClass = await page.locator('.agent-status').getAttribute('class')
  const statusText = await page.locator('.agent-status').textContent()
  if ((statusClass || '').includes('agent-status--ok')) ok(`New Session shows availability: "${(statusText || '').trim()}"`)
  else bad(`unexpected status: ${statusClass} / ${statusText}`)

  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ AGENT DETECTION WORKS')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
