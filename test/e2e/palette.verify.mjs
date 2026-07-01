import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const NODE = process.execPath
const DATA = '/tmp/crew-palette-data'
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
  await page.evaluate(
    async ({ node, cwd }) => {
      const busy = 'setInterval(()=>process.stdout.write("."),300)'
      await window.crew.createSession({ presetId: null, command: node, args: ['-e', busy], cwd, label: 'Alpha' })
      await window.crew.createSession({ presetId: null, command: node, args: ['-e', busy], cwd, label: 'Bravo' })
    },
    { node: NODE, cwd: ROOT }
  )
  await waitUntil(async () => (await page.locator('.card').count()) === 2, 'two cards')

  // ⌘K palette → filter → Enter selects
  await page.keyboard.press('Meta+k')
  await page.waitForSelector('.palette')
  ok('Cmd-K opens the command palette')
  await page.locator('.palette__input').fill('Bravo')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await page.locator('.session-header__label').textContent().catch(() => '')) === 'Bravo',
    'palette selected Bravo'
  )
  ok('typing + Enter jumps to the chosen session')

  // ⌘N opens New Session
  await page.keyboard.press('Meta+n')
  await page.waitForSelector('.modal:has-text("New Session")')
  ok('Cmd-N opens New Session')
  await page.keyboard.press('Escape')

  // ⌘2 selects the 2nd session
  await page.keyboard.press('Meta+1')
  await waitUntil(
    async () => (await page.locator('.session-header__label').textContent().catch(() => '')) === 'Alpha',
    'Cmd-1 selected first session'
  )
  ok('Cmd-1 selects the first session')

  await page.evaluate(async () => { const r = await window.crew.getRoster(); for (const s of r) await window.crew.closeSession(s.id) })
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ PALETTE + SHORTCUTS WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
