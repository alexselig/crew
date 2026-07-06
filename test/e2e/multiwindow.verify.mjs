// Verifies multi-monitor support: a second app window in the SAME instance that
// shares session state (broadcast roster/output) but has its own independent
// selection. Screenshots -> $SHOTS (default: /tmp/crew-mw).

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-mw'
mkdirSync(SHOTS, { recursive: true })
const ROOT = resolve(process.cwd())
const DATA_DIR = '/tmp/crew-mw-data'
rmSync(DATA_DIR, { recursive: true, force: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fail = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  ✓', msg, extra)
  else { fail++; console.log('  ✗', msg, extra) }
}

async function newSession(page, label) {
  await page.locator('.roster__header button:has-text("New Session")').first().click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.locator('.modal select.field__input').selectOption('shell')
  await page.locator('.field:has(.field__label:has-text("Working directory")) input').fill(ROOT)
  await page.locator('.field:has(.field__label:has-text("Label")) input').fill(label)
  await page.locator('.modal button:has-text("Launch")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
}

async function forceSingleView(page) {
  const btn = page.locator('button[title="Focus view"]')
  if (await btn.count()) await btn.first().click()
}

async function main() {
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page1 = await app.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  await page1.waitForSelector('.app', { timeout: 10000 })
  ok(app.windows().length === 1, 'starts with a single window')

  await newSession(page1, 'Session A')
  await newSession(page1, 'Session B')
  await page1.waitForSelector('.card', { timeout: 8000 })

  // --- Open a second window (same instance) ---
  await page1.evaluate(() => window.crew.openWindow())
  const page2 = await app.waitForEvent('window', { timeout: 8000 })
  await page2.waitForLoadState('domcontentloaded')
  await page2.waitForSelector('.app', { timeout: 10000 })
  ok(app.windows().length === 2, 'openWindow() opens a second window')
  ok(page2.url().includes('intro=0'), 'second window skips the launch sequence')

  // --- Shared roster (same session data in both windows) ---
  const roster2 = await page2.evaluate(async () =>
    (await window.crew.getRoster()).map((s) => s.label)
  )
  ok(
    roster2.includes('Session A') && roster2.includes('Session B'),
    'second window shares the roster',
    `(${roster2.join(', ')})`
  )

  // --- Roster broadcast: a session created in win1 appears live in win2 ---
  await newSession(page1, 'Session C')
  let sawC = false
  for (let i = 0; i < 30 && !sawC; i++) {
    sawC = (await page2.locator('.card:has-text("Session C")').count()) > 0
    await sleep(150)
  }
  ok(sawC, 'new session broadcasts live to the second window')

  // --- Independent selection: different session focused in each window ---
  await forceSingleView(page1)
  await forceSingleView(page2)
  await page1.locator('.card:has-text("Session A")').first().click()
  await page2.locator('.card:has-text("Session B")').first().click()
  await sleep(300)
  const h1 = (await page1.locator('.session-header__label').first().textContent())?.trim()
  const h2 = (await page2.locator('.session-header__label').first().textContent())?.trim()
  ok(h1 === 'Session A', 'window 1 keeps its own selection', `(${h1})`)
  ok(h2 === 'Session B', 'window 2 has an independent selection', `(${h2})`)
  await page1.screenshot({ path: join(SHOTS, 'win1-session-a.png') })
  await page2.screenshot({ path: join(SHOTS, 'win2-session-b.png') })

  // --- Live terminal output routes to the second window ---
  await page2.locator('.xterm').first().click()
  await page2.keyboard.type('echo hello-window-two')
  await page2.keyboard.press('Enter')
  let sawEcho = false
  for (let i = 0; i < 40 && !sawEcho; i++) {
    const t = await page2.locator('.xterm-rows').first().textContent()
    sawEcho = !!t && t.includes('hello-window-two')
    await sleep(150)
  }
  ok(sawEcho, 'live terminal output works in the second window')

  // --- Independent view state (the multi-screen grouping/display bug) ---
  ok(page1.url().includes('w=0'), 'first window gets slot 0', `(${new URL(page1.url()).search})`)
  ok(page2.url().includes('w=1'), 'second window gets slot 1', `(${new URL(page2.url()).search})`)

  const chooseGroup = async (page, label) => {
    await page.locator('button[title="Group sessions"]').first().click()
    await page.locator('.group-menu__item', { hasText: label }).first().click()
    await sleep(150)
  }

  // Group by tag in window 1 only; window 2 must stay ungrouped.
  await chooseGroup(page1, 'By group')
  const w1cls = (await page1.locator('button[title="Group sessions"]').first().getAttribute('class')) || ''
  const w2cls = (await page2.locator('button[title="Group sessions"]').first().getAttribute('class')) || ''
  ok(w1cls.includes('is-active'), 'window 1 reflects its own grouping choice')
  ok(!w2cls.includes('is-active'), 'window 2 is unaffected by window 1 grouping')

  // Each window persists to its own slot namespace, never a shared key.
  const keys = await page1.evaluate(() => ({
    w0: localStorage.getItem('crew.w0.groupMode'),
    w1: localStorage.getItem('crew.w1.groupMode')
  }))
  ok(keys.w0 === 'tag', 'window 1 view state persists to its own slot key', `(crew.w0.groupMode=${keys.w0})`)
  ok(keys.w1 !== 'tag', 'window 2 slot key not clobbered by window 1', `(crew.w1.groupMode=${keys.w1})`)

  await app.close()
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
