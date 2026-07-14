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
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-shots'
const ROOT = resolve('/Users/alexselig/crew')
const DATA_DIR = '/tmp/crew-shots-data'
const NODE_BIN = process.execPath
mkdirSync(SHOTS, { recursive: true })

// Distinct character + vivid identity color per session (colors from
// src/shared/palette.ts, spread across the wheel: orange / cyan / green / violet).
const SESSIONS = [
  {
    label: 'the-iron-wake',
    character: 'fox',
    color: '#ff7a3c', // orange
    // "working": print rich content, then keep emitting dots so it stays WORKING.
    script:
      'process.stdout.write("the-iron-wake \\u00b7 godot 4.3\\n' +
      'Added parallax fog layer to Blackwake Harbor\\n' +
      '\\u2713 fog_layer.gd        +38  -4\\n' +
      '\\u2713 harbor_scene.tscn   updated\\n' +
      '\\u2713 export-release Web \\u2192 docs/   (2.3s)\\n' +
      'Total cost: $0.31\\n\\n' +
      'Wiring the lighthouse beam shader\\u2026\\n' +
      '\\u2713 beam.gdshader created\\n' +
      '\\u2192 tuning falloff + bloom\\n");' +
      'setInterval(()=>process.stdout.write("."),300)'
  },
  {
    label: 'poseforge',
    character: 'bear',
    color: '#37c0e6', // cyan
    script:
      'process.stdout.write("Generating pose sheet (gemini-2.5-flash-image)\\n' +
      '\\u2713 4/6 poses rendered\\n' +
      'Total cost: $0.42\\n");' +
      'setInterval(()=>process.stdout.write("."),300)'
  },
  {
    label: 'farmframe',
    character: 'deer',
    color: '#7ed957', // green
    // "waiting": print a question ending in a prompt, then idle.
    script:
      'process.stdout.write("Prisma schema change detected\\n' +
      '  drift: add column projects.archived_at\\n\\n' +
      'Apply this migration to dev.db? (y/n)\\n> ");' +
      'setInterval(()=>{},1000)'
  },
  {
    label: 'crew',
    character: 'owl',
    color: '#8a6dff', // violet
    script:
      'process.stdout.write("Two approaches for the skills menu:\\n' +
      '  1) floating overlay   2) docked bar\\n\\n' +
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

  // Create the four sessions in order.
  for (const s of SESSIONS) {
    await page.evaluate(
      async ({ node, script, label, root }) => {
        await window.crew.createSession({ presetId: null, command: node, args: ['-e', script], cwd: root, label })
      },
      { node: NODE_BIN, script: s.script, label: s.label, root: ROOT }
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
  // Select the-iron-wake in the roster.
  await page.locator('.roster__list .card:has-text("the-iron-wake")').click()
  await page.mouse.move(1100, 700)
  await wait(600)
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
  console.log('Screenshots written to', SHOTS)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
