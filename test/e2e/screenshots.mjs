// Portfolio screenshot harness. Launches the built app, stages four sessions
// with DISTINCT characters + identity colors (so it reads at a glance that each
// session is its own agent), feeds realistic terminal output, and captures the
// loading poster, grid, focus, new-session, skills, and collapsed-rail views.
//
//   npm run build && node test/e2e/screenshots.mjs
//   SHOTS=/tmp/crew-shots node test/e2e/screenshots.mjs
//
// Output: SHOTS/{00-loading,01-grid,02-focus,03-new-session,04-skills,05-compact}.png

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const SHOTS = process.env.SHOTS || '/tmp/crew-shots'
const ROOT = resolve('/Users/alexselig/crew')
const DATA_DIR = '/tmp/crew-shots-data'
const NODE_BIN = process.execPath

// Autopilot staging. Crew detects a session as "on autopilot" from its agent's
// own state — for Claude Code, the permissionMode in its transcript under
// ~/.claude/projects/<cwd-with-dashes>/. We fake ONE session as a Claude session
// (a `claude`-named symlink to node, so isClaudeSession() is true while we still
// run our own scripted output) working out of a throwaway cwd, and drop a
// transcript there whose permissionMode is "acceptEdits" — which Crew surfaces as
// the pilot costume. Everything lives under /tmp and is removed on exit; the only
// touch to ~/.claude is a single clearly-named throwaway project dir, also removed.
const SHIM_DIR = '/tmp/crew-shots-bin'
const CLAUDE_SHIM = join(SHIM_DIR, 'claude')
const AP_CWD = '/tmp/crew-shots-proj/atlas-web'
const AP_PROJECT_DIR = join(homedir(), '.claude', 'projects', AP_CWD.replace(/[^a-zA-Z0-9]/g, '-'))

mkdirSync(SHOTS, { recursive: true })

// Distinct character + vivid identity color per session (colors from
// src/shared/palette.ts, spread across the wheel: orange / cyan / green / violet).
// Names are generic placeholders — NOT real projects. One session (atlas-web) runs
// on autopilot (see the staging note above) so the pilot costume is on display.
const SESSIONS = [
  {
    label: 'atlas-web',
    character: 'fox',
    color: '#ff7a3c', // orange
    autopilot: true, // running unattended — shows the pilot costume
    command: CLAUDE_SHIM,
    cwd: AP_CWD,
    // "working": print rich content, then keep emitting dots so it stays WORKING.
    script:
      'process.stdout.write("atlas-web \\u00b7 vite + react\\n' +
      'Refactoring checkout into a guided wizard\\n' +
      '\\u2713 CheckoutSteps.tsx     +64  -12\\n' +
      '\\u2713 useCartTotals.ts      added\\n' +
      '\\u2713 npm test \\u2014 48 passed   (3.1s)\\n' +
      'Total cost: $0.28\\n\\n' +
      'Extracting the address form into a step\\u2026\\n' +
      '\\u2713 AddressStep.tsx created\\n' +
      '\\u2192 wiring validation + autosave\\n");' +
      'setInterval(()=>process.stdout.write("."),300)'
  },
  {
    label: 'nimbus-api',
    character: 'bear',
    color: '#37c0e6', // cyan
    script:
      'process.stdout.write("nimbus-api \\u00b7 go 1.23\\n' +
      'Adding token-bucket rate limiting to the gateway\\n' +
      '\\u2713 middleware/ratelimit.go   +91\\n' +
      '\\u2713 100 req/min per API key\\n' +
      'Total cost: $0.35\\n");' +
      'setInterval(()=>process.stdout.write("."),300)'
  },
  {
    label: 'beacon-db',
    character: 'deer',
    color: '#7ed957', // green
    // "waiting": print a question ending in a prompt, then idle.
    script:
      'process.stdout.write("beacon-db \\u00b7 migration check\\n' +
      'Schema drift detected on staging\\n' +
      '  add index on events(created_at)\\n\\n' +
      'Apply this migration to staging? (y/n)\\n> ");' +
      'setInterval(()=>{},1000)'
  },
  {
    label: 'lumen-cli',
    character: 'owl',
    color: '#8a6dff', // violet
    script:
      'process.stdout.write("lumen-cli\\n' +
      'Two ways to structure the plugin API:\\n' +
      '  1) hook registry   2) event bus\\n\\n' +
      'Which do you prefer? \\u203a ");' +
      'setInterval(()=>{},1000)'
  }
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn, desc, timeout = 15000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await wait(interval)
  }
  throw new Error(`timeout: ${desc}`)
}

// The Assets panel loads thumbnails over crew-asset://, which 404s if the <img>
// requests a file before the cwd scan has populated the allowlist — a broken
// image that never retries. Wait for every thumbnail to decode, force-reloading
// any that are still broken (a fresh cache-bust re-requests, and by then the
// file is allowlisted). Returns false if some stay broken past the timeout.
async function ensureThumbsLoaded(page, timeout = 6000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const st = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.asset__thumb')]
      let broken = 0
      for (const img of imgs) {
        if (!img.complete || img.naturalWidth === 0) {
          broken++
          const base = (img.getAttribute('src') || '').split('?')[0]
          if (base) img.setAttribute('src', base + '?v=' + Date.now() + '-' + Math.random())
        }
      }
      return { total: imgs.length, broken }
    })
    if (st.total > 0 && st.broken === 0) return true
    await wait(300)
  }
  return false
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })
  // Resize the window to a 1.6 logical aspect ratio while keeping the display's
  // native devicePixelRatio, so captures stay retina-crisp AND downscale cleanly
  // to the portfolio's 1600x1000 assets (the PPTX export montage skews non-1.6).
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setContentSize(1120, 700)
  })

  // ---- 00: loading / start poster ----
  // The intro is skipped under automation (App.tsx checks navigator.webdriver),
  // so force it on for one capture, then click through the fly-in to reveal the
  // app before staging sessions.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  await page.reload()
  await page.waitForSelector('.intro', { timeout: 6000 })
  await wait(900)
  await page.screenshot({ path: join(SHOTS, '00-loading.png') })
  await page.locator('.intro').click()
  await waitUntil(async () => (await page.locator('.intro').count()) === 0, 'intro dismissed', 12000)
  await wait(400)

  // Stage the autopilot session's Claude shim + a transcript whose permissionMode
  // is "acceptEdits" so Crew's autopilot poll flips atlas-web into pilot mode.
  rmSync(SHIM_DIR, { recursive: true, force: true })
  mkdirSync(SHIM_DIR, { recursive: true })
  symlinkSync(NODE_BIN, CLAUDE_SHIM)
  mkdirSync(AP_CWD, { recursive: true })
  mkdirSync(AP_PROJECT_DIR, { recursive: true })
  // Seed a few previewable files in the autopilot session's cwd so its Assets
  // panel shows real image thumbnails — a plausible checkout refactor's output
  // (all generic, no real names). SVGs render crisply at the 40px thumbnail size.
  mkdirSync(join(AP_CWD, 'public'), { recursive: true })
  writeFileSync(
    join(AP_CWD, 'index.html'),
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <link rel="icon" href="/public/logo.svg" />\n    <title>atlas-web</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n'
  )
  writeFileSync(
    join(AP_CWD, 'public', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#ff7a3c"/><path d="M40 90 L64 38 L88 90 M50 74 H78" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\n'
  )
  // A square mock of the checkout wizard the agent is building — reads as a mini
  // UI card even at thumbnail size (and center-crops cleanly).
  writeFileSync(
    join(AP_CWD, 'public', 'checkout-preview.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
      '<rect width="400" height="400" fill="#0f1115"/>' +
      '<rect x="44" y="40" width="312" height="320" rx="22" fill="#f5f6f8"/>' +
      '<text x="72" y="96" font-family="Georgia, serif" font-size="32" fill="#1a1c22">Checkout</text>' +
      '<circle cx="250" cy="84" r="7" fill="#ff7a3c"/><circle cx="280" cy="84" r="7" fill="#d7dae0"/><circle cx="310" cy="84" r="7" fill="#d7dae0"/>' +
      '<rect x="72" y="132" width="256" height="34" rx="8" fill="#e7e9ee"/>' +
      '<rect x="72" y="182" width="256" height="34" rx="8" fill="#e7e9ee"/>' +
      '<rect x="72" y="232" width="118" height="34" rx="8" fill="#e7e9ee"/>' +
      '<rect x="210" y="232" width="118" height="34" rx="8" fill="#e7e9ee"/>' +
      '<rect x="72" y="296" width="256" height="42" rx="11" fill="#ff7a3c"/>' +
      '<rect x="150" y="312" width="100" height="10" rx="5" fill="#fff"/>' +
      '</svg>\n'
  )
  writeFileSync(
    join(AP_PROJECT_DIR, 'shot.jsonl'),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      permissionMode: 'acceptEdits',
      message: { role: 'user', content: 'go' }
    }) + '\n'
  )

  // Create the four sessions in order.
  for (const s of SESSIONS) {
    await page.evaluate(
      async ({ command, script, label, cwd }) => {
        await window.crew.createSession({ presetId: null, command, args: ['-e', script], cwd, label })
      },
      { command: s.command || NODE_BIN, script: s.script, label: s.label, cwd: s.cwd || ROOT }
    )
    await wait(250)
  }
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 4, 'four cards')

  // Assign a distinct character + color to each session by matching its label.
  const roster = await page.evaluate(() => window.crew.getRoster())
  for (const s of SESSIONS) {
    const info = roster.find((r) => r.label === s.label)
    if (!info) continue
    await page.evaluate(
      async ({ id, character, color }) => {
        await window.crew.setCharacter(id, character)
        await window.crew.setColor(id, color)
      },
      { id: info.id, character: s.character, color: s.color }
    )
  }
  // Let output settle so states resolve (2 working, 2 waiting) and colors apply.
  await wait(1600)
  // Wait for the autopilot poll to read the acceptEdits transcript so atlas-web is
  // wearing the pilot costume before we capture.
  await waitUntil(
    async () => (await page.evaluate(() => window.crew.getRoster())).some((s) => s.label === 'atlas-web' && s.autopilot === true),
    'atlas-web on autopilot',
    12000
  )

  // ---- 01: grid (mission control) ----
  await page.locator('.view-toggle__btn').nth(1).click()
  await waitUntil(async () => (await page.locator('.grid .tile').count()) === 4, 'four grid tiles')
  // Move the pointer off the left edge so the nav rail doesn't float open over the grid.
  await page.mouse.move(1100, 700)
  await wait(700)
  await page.screenshot({ path: join(SHOTS, '01-grid.png') })

  // ---- 02: focus (roster + live terminal + assets) ----
  await page.locator('.view-toggle__btn').nth(0).click()
  await waitUntil(async () => (await page.locator('.session-view').count()) === 1, 'focus view')
  // Select the autopilot session (atlas-web) so the pilot costume is prominent.
  await page.locator('.roster__list .card:has-text("atlas-web")').click()
  await page.mouse.move(1100, 700)
  await wait(600)
  // Make sure the asset thumbnails have actually decoded (crew-asset:// first-
  // paint race) so the panel shows real previews, not broken-image icons.
  await ensureThumbsLoaded(page)
  await wait(200)
  await page.screenshot({ path: join(SHOTS, '02-focus.png') })

  // ---- 03: skills gallery (built-in skills fall back when no agent) ----
  const skillsToggle = page.locator('.skills-menu__toggle')
  if (await skillsToggle.count()) {
    await skillsToggle.click()
    await waitUntil(async () => (await page.locator('.skills-menu.is-open').count()) === 1, 'skills open')
    await wait(600)
    await page.screenshot({ path: join(SHOTS, '03-skills.png') })
    await page.keyboard.press('Escape')
    await wait(300)
  }

  // ---- 04: new-session modal (Claude / Copilot / Shell) ----
  const newBtn = page.locator('button:has-text("New session"), [title="New session"]').first()
  await newBtn.click()
  await waitUntil(async () => (await page.locator('.modal, [role="dialog"]').count()) >= 1, 'modal open')
  await wait(500)
  await page.screenshot({ path: join(SHOTS, '04-new-session.png') })
  await page.keyboard.press('Escape')
  await wait(300)

  // ---- 05: compact rail (collapsed sidebar) ----
  const collapse = page.locator('.icon-btn[title="Collapse sidebar"]')
  if (await collapse.count()) {
    await collapse.click()
    await page.mouse.move(1100, 700)
    await wait(600)
    await page.screenshot({ path: join(SHOTS, '05-compact.png') })
  }

  await app.close()
  // Remove the autopilot staging (temp shim + throwaway cwd + fake Claude project).
  rmSync(SHIM_DIR, { recursive: true, force: true })
  rmSync('/tmp/crew-shots-proj', { recursive: true, force: true })
  rmSync(AP_PROJECT_DIR, { recursive: true, force: true })
  console.log('Screenshots written to', SHOTS)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
