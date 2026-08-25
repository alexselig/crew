import { _electron as electron } from 'playwright'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-github-data'
const REPO_URL = 'https://github.com/alexselig/crew'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
const note = (m) => console.log('  · ' + m)
async function waitUntil(fn, d, t = 9000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }
const launch = () => electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const plain = mkdtempSync(join(tmpdir(), 'crew-nogit-'))
  const app = await launch()
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  // Stub shell.openExternal in main so clicking the button can't spawn a real
  // browser, and record the URL it was asked to open.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    Object.defineProperty(shell, 'openExternal', {
      value: async (u) => { globalThis.__opened.push(u); return true },
      configurable: true,
      writable: true
    })
  })

  // (A) A session whose cwd is the crew repo (has a GitHub origin) → button shows.
  await page.evaluate((cwd) => window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Repo' }), ROOT)
  await page.waitForSelector('.xterm')
  await waitUntil(async () => (await page.locator('.session-tools .github-btn').count()) === 1, 'github button appears')
  ok('GitHub button appears next to Skills for a GitHub-repo session')

  // It sits immediately before the Skills toggle inside the tools cluster.
  const order = await page.locator('.session-tools > *').evaluateAll((els) =>
    els.map((e) => (e.classList.contains('github-btn') ? 'github' : e.classList.contains('skills-menu') ? 'skills' : e.className))
  )
  if (JSON.stringify(order) === JSON.stringify(['github', 'skills'])) ok('GitHub chip is left of the Skills button')
  else bad('unexpected tools order: ' + JSON.stringify(order))

  const url = await page.evaluate((cwd) => window.crew.getGithubUrl(cwd), ROOT)
  if (url === REPO_URL) ok('resolved the origin remote → ' + url)
  else bad('unexpected resolved URL: ' + JSON.stringify(url))

  // (B) Click → copies the URL, opens it (stubbed), shows a Copied confirmation.
  await page.locator('.session-tools .github-btn').click()
  await waitUntil(async () => ((await page.locator('.session-tools .github-btn').textContent()) || '').includes('Copied'), 'shows Copied')
  ok('clicking shows the Copied confirmation')

  const opened = await app.evaluate(() => globalThis.__opened || [])
  if (opened.includes(REPO_URL)) ok('opened the repo URL in the browser (stubbed)')
  else bad('open did not receive the URL: ' + JSON.stringify(opened))

  const clip = await page.evaluate(() => navigator.clipboard.readText().then((t) => t).catch(() => '__denied__'))
  if (clip === REPO_URL) ok('copied the URL to the clipboard')
  else if (clip === '__denied__') note('clipboard read blocked in test env — Copied label already confirms writeText resolved')
  else bad('clipboard mismatch: ' + JSON.stringify(clip))

  // (C) A non-git session → no button.
  await page.evaluate((cwd) => window.crew.createSession({ presetId: 'shell', command: '/bin/bash', args: ['-l'], cwd, label: 'Plain' }), plain)
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) >= 2, 'two sessions')
  await page.locator('.roster__list .card:has-text("Plain")').click()
  await page.waitForTimeout(400)
  if ((await page.locator('.session-tools .github-btn').count()) === 0) ok('no GitHub button for a session without a GitHub remote')
  else bad('GitHub button wrongly shown for a non-git session')
  // …but the Skills button is still present for that session.
  if ((await page.locator('.session-tools .skills-menu__toggle').count()) === 1) ok('Skills button still present on the non-git session')
  else bad('Skills button missing on the non-git session')

  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  rmSync(plain, { recursive: true, force: true })
  if (errs.length) bad('page errors: ' + errs.join(' | '))
  if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1) }
  console.log('\nAll GitHub-button checks passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
