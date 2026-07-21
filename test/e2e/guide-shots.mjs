// Guide screenshot harness for the "Crew Explained" docs page (v0.3.0).
// Reuses the portfolio harness' scene but stages each session in its own
// throwaway git repo (generic data, a local demo identity — never the user's
// real projects) so the Project Tracker renders a clean multi-project
// dashboard. Captures the fuller set of feature states the guide indexes:
// character/color picker, sort menu, assets preview, grouped grid, the Project
// Tracker, every modal (broadcast, activity spend + activity tabs, transcripts,
// settings, palette, new session), plus close-ups of the sidebar toolbar,
// title bar and a grid tile.
//
//   npm run build && node test/e2e/guide-shots.mjs
//   SHOTS=/tmp/crew-guide node test/e2e/guide-shots.mjs
//
// Each capture is wrapped so one flaky step never aborts the whole run.

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const SHOTS = process.env.SHOTS || '/tmp/crew-guide'
const ROOT = resolve('/Users/alexselig/crew')
const DATA_DIR = '/tmp/crew-guide-data'
const NODE_BIN = process.execPath
const PROJ_ROOT = '/tmp/crew-guide-proj'

// The autopilot session is a `claude`-named shim (so isClaudeSession() is true)
// running out of a throwaway cwd; a transcript with permissionMode "acceptEdits"
// makes Crew surface the pilot costume. See screenshots.mjs for the full note.
const SHIM_DIR = '/tmp/crew-guide-bin'
const CLAUDE_SHIM = join(SHIM_DIR, 'claude')
const AP_CWD = join(PROJ_ROOT, 'atlas-web')
const AP_PROJECT_DIR = join(homedir(), '.claude', 'projects', AP_CWD.replace(/[^a-zA-Z0-9]/g, '-'))

mkdirSync(SHOTS, { recursive: true })

// Each session gets a distinct character + vivid identity color, a group tag
// (so grouping + the tracker read richly), and its own throwaway git repo with
// a package.json, README, a TODO with next steps, and a few commits.
const SESSIONS = [
  {
    label: 'atlas-web',
    character: 'fox',
    color: '#ff7a3c',
    tag: 'product',
    autopilot: true,
    command: CLAUDE_SHIM,
    cwd: AP_CWD,
    version: '0.4.2',
    pkg: { dependencies: { react: '^18.3.0', vite: '^5.4.0' } },
    todo: '# atlas-web\n\n## Next steps\n- [ ] Wire address autosave into the checkout wizard\n- [ ] Add a review step before payment\n- [ ] Persist the cart across reloads\n',
    commits: ['Scaffold the checkout wizard', 'Add CheckoutSteps + cart totals', 'Release v0.4.2 — guided checkout'],
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
    color: '#37c0e6',
    tag: 'product',
    version: '1.3.0',
    pkg: { dependencies: { express: '^4.19.0' } },
    todo: '# nimbus-api\n\n## Next steps\n- [ ] Add per-key rate-limit metrics\n- [ ] Document the gateway config\n',
    commits: ['Set up the gateway', 'Add token-bucket rate limiting', 'Release v1.3.0'],
    script:
      'process.stdout.write("nimbus-api \\u00b7 node gateway\\n' +
      'Adding token-bucket rate limiting to the gateway\\n' +
      '\\u2713 middleware/ratelimit.js   +91\\n' +
      '\\u2713 100 req/min per API key\\n' +
      'Total cost: $0.35\\n");' +
      'setInterval(()=>process.stdout.write("."),300)'
  },
  {
    label: 'beacon-db',
    character: 'deer',
    color: '#7ed957',
    tag: 'infra',
    version: '0.9.1',
    pkg: {},
    todo: '# beacon-db\n\n## Next steps\n- [ ] Apply the staging index migration\n- [ ] Backfill events(created_at)\n',
    commits: ['Initial schema', 'Add migration runner'],
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
    color: '#8a6dff',
    tag: 'infra',
    version: '0.2.0',
    pkg: {},
    todo: '# lumen-cli\n\n## Next steps\n- [ ] Decide plugin API shape (hooks vs event bus)\n- [ ] Ship the first release\n',
    commits: ['Bootstrap the CLI', 'Sketch the plugin API'],
    script:
      'process.stdout.write("lumen-cli\\n' +
      'Two ways to structure the plugin API:\\n' +
      '  1) hook registry   2) event bus\\n\\n' +
      'Which do you prefer? \\u203a ");' +
      'setInterval(()=>{},1000)'
  }
]

// Each session lives in its own throwaway repo dir under PROJ_ROOT.
for (const s of SESSIONS) s.cwd = s.cwd || join(PROJ_ROOT, s.label)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn, desc, timeout = 15000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await wait(interval)
  }
  throw new Error(`timeout: ${desc}`)
}

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

// Build a throwaway git repo with a package.json, README, TODO + a few commits.
// Uses a fixed local demo identity so no real name lands in a screenshot.
function makeRepo(s) {
  const dir = s.cwd
  mkdirSync(dir, { recursive: true })
  const pkg = { name: s.label, version: s.version, private: true, ...(s.pkg || {}) }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), `# ${s.label}\n\nA demo project for the Crew guide.\n`)
  writeFileSync(join(dir, 'TODO.md'), s.todo)
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=Crew Demo', '-c', 'user.email=demo@crew.local', '-c', 'commit.gpgsign=false', ...args],
      { stdio: 'ignore' }
    )
  try {
    git('init', '-q', '-b', 'main')
    for (const [i, msg] of (s.commits || ['Initial commit']).entries()) {
      writeFileSync(join(dir, `.step-${i}`), String(i))
      git('add', '-A')
      git('commit', '-q', '-m', msg)
    }
  } catch {
    // git missing / init failed — the tracker will just show a lighter card.
  }
}

const done = []
const failed = []

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })

  // Stage the throwaway project repos before launching (the tracker scans cwds).
  rmSync(PROJ_ROOT, { recursive: true, force: true })
  for (const s of SESSIONS) makeRepo(s)
  // atlas-web also gets previewable assets so its Assets panel shows thumbnails.
  mkdirSync(join(AP_CWD, 'public'), { recursive: true })
  writeFileSync(
    join(AP_CWD, 'index.html'),
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="UTF-8" />\n<title>atlas-web — checkout</title>\n<style>\n  body{margin:0;font-family:Georgia,serif;background:#0f1115;color:#f5f6f8;display:grid;place-items:center;height:100vh}\n  .card{width:320px;background:#f5f6f8;color:#1a1c22;border-radius:18px;padding:28px 26px;box-shadow:0 20px 60px rgba(0,0,0,.5)}\n  .dots{display:flex;gap:7px;margin-bottom:18px}\n  .dots span{width:9px;height:9px;border-radius:50%;background:#d7dae0}\n  .dots span:first-child{background:#ff7a3c}\n  h1{font-size:22px;margin:0 0 18px}\n  .row{height:34px;background:#e7e9ee;border-radius:8px;margin:10px 0}\n  .row.half{width:48%}\n  .pair{display:flex;justify-content:space-between}\n  .btn{margin-top:16px;height:42px;background:#ff7a3c;border-radius:11px;display:grid;place-items:center;color:#fff;font-family:system-ui,sans-serif;font-weight:600}\n</style>\n</head>\n<body>\n  <div class="card">\n    <div class="dots"><span></span><span></span><span></span></div>\n    <h1>Checkout</h1>\n    <div class="row"></div>\n    <div class="row"></div>\n    <div class="pair"><div class="row half"></div><div class="row half"></div></div>\n    <div class="btn">Pay now</div>\n  </div>\n</body>\n</html>\n'
  )
  writeFileSync(
    join(AP_CWD, 'public', 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#ff7a3c"/><path d="M40 90 L64 38 L88 90 M50 74 H78" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>\n'
  )
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
  // Re-commit atlas-web so the new files are part of its history.
  const apGit = (...args) =>
    execFileSync(
      'git',
      ['-C', AP_CWD, '-c', 'user.name=Crew Demo', '-c', 'user.email=demo@crew.local', '-c', 'commit.gpgsign=false', ...args],
      { stdio: 'ignore' }
    )
  try {
    apGit('add', '-A')
    apGit('commit', '-q', '-m', 'Add checkout preview + logo')
  } catch {}

  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setContentSize(1120, 700)
  })

  async function shot(name, fn) {
    try {
      await fn()
      done.push(name)
    } catch (e) {
      failed.push(`${name}: ${e.message}`)
      try {
        await page.keyboard.press('Escape')
      } catch {}
      await wait(200)
    }
  }
  const full = (name) => page.screenshot({ path: join(SHOTS, name) })
  const clip = (sel, name) => page.locator(sel).first().screenshot({ path: join(SHOTS, name) })

  // ---- loading poster ----
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false })
  })
  await page.reload()
  await shot('loading.png', async () => {
    await page.waitForSelector('.intro', { timeout: 6000 })
    await wait(900)
    await full('loading.png')
  })
  try {
    await page.locator('.intro').click()
    await waitUntil(async () => (await page.locator('.intro').count()) === 0, 'intro dismissed', 12000)
  } catch {}
  await wait(400)

  // Autopilot staging for atlas-web.
  rmSync(SHIM_DIR, { recursive: true, force: true })
  mkdirSync(SHIM_DIR, { recursive: true })
  symlinkSync(NODE_BIN, CLAUDE_SHIM)
  mkdirSync(AP_PROJECT_DIR, { recursive: true })
  writeFileSync(
    join(AP_PROJECT_DIR, 'shot.jsonl'),
    JSON.stringify({
      type: 'user',
      timestamp: new Date().toISOString(),
      permissionMode: 'acceptEdits',
      message: { role: 'user', content: 'go' }
    }) + '\n'
  )

  for (const s of SESSIONS) {
    await page.evaluate(
      async ({ command, script, label, cwd, tag }) => {
        await window.crew.createSession({ presetId: null, command, args: ['-e', script], cwd, label, tag })
      },
      { command: s.command || NODE_BIN, script: s.script, label: s.label, cwd: s.cwd, tag: s.tag }
    )
    await wait(250)
  }
  await waitUntil(async () => (await page.locator('.roster__list .card').count()) === 4, 'four cards')

  const roster = await page.evaluate(() => window.crew.getRoster())
  for (const s of SESSIONS) {
    const info = roster.find((r) => r.label === s.label)
    if (!info) continue
    await page.evaluate(
      async ({ id, character, color, tag }) => {
        await window.crew.setCharacter(id, character)
        await window.crew.setColor(id, color)
        if (tag) await window.crew.setTag(id, tag)
      },
      { id: info.id, character: s.character, color: s.color, tag: s.tag }
    )
  }
  await wait(1600)
  try {
    await waitUntil(
      async () =>
        (await page.evaluate(() => window.crew.getRoster())).some(
          (s) => s.label === 'atlas-web' && s.autopilot === true
        ),
      'atlas-web on autopilot',
      12000
    )
  } catch {}

  // ===== FOCUS VIEW =====
  await page.locator('.view-toggle__btn').nth(0).click()
  await waitUntil(async () => (await page.locator('.session-view').count()) === 1, 'focus view')
  await page.locator('.roster__list .card:has-text("atlas-web")').click()
  await page.mouse.move(1100, 700)
  await wait(500)
  await ensureThumbsLoaded(page)
  await wait(200)

  await shot('focus.png', () => full('focus.png'))
  await shot('titlebar.png', () => clip('.session-header', 'titlebar.png'))
  await shot('toolbar.png', () => clip('.roster__toolbar', 'toolbar.png'))
  await shot('card.png', () => clip('.roster__list .card:has-text("beacon-db")', 'card.png'))

  await shot('character-picker.png', async () => {
    await page.locator('.session-header .char-picker__mascot').click()
    await waitUntil(async () => (await page.locator('.char-picker__panel').count()) === 1, 'char panel')
    await wait(400)
    await full('character-picker.png')
    await page.keyboard.press('Escape')
    await page.mouse.click(700, 360)
    await wait(200)
  })

  await shot('assets.png', async () => {
    const html = page.locator('.asset:has-text("index.html")').first()
    if (await html.count()) {
      await html.click()
      await waitUntil(async () => (await page.locator('.assets__preview').count()) === 1, 'asset preview')
      await wait(500)
    }
    await clip('.assets', 'assets.png')
    const closeP = page.locator('.assets__preview [title="Close preview"]')
    if (await closeP.count()) await closeP.click()
    await wait(150)
  })

  await shot('sort-menu.png', async () => {
    await page.locator('.roster__toolbar .group-picker button').click()
    await waitUntil(async () => (await page.locator('.group-menu').count()) === 1, 'group menu')
    await wait(300)
    await full('sort-menu.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  await shot('skills.png', async () => {
    await page.locator('.skills-menu__toggle').click()
    await waitUntil(async () => (await page.locator('.skills-menu.is-open').count()) === 1, 'skills open')
    await wait(500)
    await full('skills.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  await shot('broadcast.png', async () => {
    await page.locator('[title="Broadcast a prompt"]').first().click()
    await waitUntil(async () => (await page.locator('.modal').count()) >= 1, 'broadcast modal')
    await wait(400)
    await full('broadcast.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  // Activity & spend — Spend tab, then Activity (commit feed) tab.
  await shot('analytics.png', async () => {
    await page.locator('[title="Activity & spend"]').first().click()
    await waitUntil(async () => (await page.locator('.modal--wide').count()) >= 1, 'analytics modal')
    await wait(400)
    await full('analytics.png')
  })
  await shot('analytics-activity.png', async () => {
    if ((await page.locator('.modal--wide').count()) === 0) {
      await page.locator('[title="Activity & spend"]').first().click()
      await waitUntil(async () => (await page.locator('.modal--wide').count()) >= 1, 'analytics modal')
    }
    const activityTab = page.locator('.analytics-tab', { hasText: 'Activity' })
    if (await activityTab.count()) {
      await activityTab.click()
      await wait(500)
    }
    await full('analytics-activity.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  // Project Tracker — the full-screen dashboard.
  await shot('tracker.png', async () => {
    await page.locator('[title="Project tracker"]').first().click()
    await waitUntil(async () => (await page.locator('.tracker-proj').count()) >= 1, 'tracker projects', 20000)
    await wait(900)
    await full('tracker.png')
    await page.keyboard.press('Escape')
    await wait(300)
  })

  await shot('settings.png', async () => {
    await page.locator('[title="Settings"]').first().click()
    await waitUntil(async () => (await page.locator('.modal').count()) >= 1, 'settings modal')
    await wait(400)
    await full('settings.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  await shot('palette.png', async () => {
    await page.keyboard.press('Meta+k')
    await waitUntil(async () => (await page.locator('.palette').count()) === 1, 'palette')
    await wait(300)
    await full('palette.png')
  })

  await shot('transcripts.png', async () => {
    if ((await page.locator('.palette').count()) === 0) {
      await page.keyboard.press('Meta+k')
      await waitUntil(async () => (await page.locator('.palette').count()) === 1, 'palette')
    }
    await page.locator('.palette__input').fill('transcripts')
    await wait(300)
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await page.locator('.modal--wide').count()) >= 1, 'transcripts modal')
    await wait(400)
    await full('transcripts.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  await shot('new-session.png', async () => {
    await page.locator('.btn--newsession').first().click()
    await waitUntil(async () => (await page.locator('.modal--session').count()) === 1, 'new session modal')
    await wait(400)
    await full('new-session.png')
  })
  await shot('new-session-advanced.png', async () => {
    if ((await page.locator('.modal--session').count()) === 0) {
      await page.locator('.btn--newsession').first().click()
      await waitUntil(async () => (await page.locator('.modal--session').count()) === 1, 'new session modal')
    }
    const adv = page.locator('.advanced__toggle')
    if (await adv.count()) {
      await adv.click()
      await waitUntil(async () => (await page.locator('.advanced__body').count()) === 1, 'advanced open')
      await wait(400)
    }
    await full('new-session-advanced.png')
    await page.keyboard.press('Escape')
    await wait(200)
  })

  // ===== GRID VIEW =====
  await shot('grid.png', async () => {
    await page.locator('.view-toggle__btn').nth(1).click()
    await waitUntil(async () => (await page.locator('.grid .tile').count()) === 4, 'four grid tiles')
    await page.mouse.move(1100, 700)
    await wait(700)
    await full('grid.png')
  })
  await shot('tile.png', () => clip('.grid .tile', 'tile.png'))

  await shot('grid-grouped.png', async () => {
    await page.locator('.grid-topbar .group-picker button').click()
    await waitUntil(async () => (await page.locator('.group-menu').count()) === 1, 'grid group menu')
    await page.locator('.group-menu__item:has-text("Needs you")').click()
    await waitUntil(async () => (await page.locator('.grid-groups').count()) === 1, 'grouped grid')
    await page.mouse.move(1100, 700)
    await wait(700)
    await full('grid-grouped.png')
    await page.locator('.grid-topbar .group-picker button').click()
    await page.locator('.group-menu__item:has-text("No grouping")').click()
    await wait(300)
  })

  await shot('compact.png', async () => {
    await page.locator('.view-toggle__btn').nth(0).click()
    await waitUntil(async () => (await page.locator('.session-view').count()) === 1, 'focus view')
    const collapse = page.locator('.icon-btn[title="Collapse sidebar"]')
    if (await collapse.count()) await collapse.click()
    await page.mouse.move(1100, 700)
    await wait(600)
    await full('compact.png')
  })

  await app.close()
  rmSync(SHIM_DIR, { recursive: true, force: true })
  rmSync(PROJ_ROOT, { recursive: true, force: true })
  rmSync(AP_PROJECT_DIR, { recursive: true, force: true })
  console.log(`Guide screenshots written to ${SHOTS}`)
  console.log(`  captured (${done.length}): ${done.join(', ')}`)
  if (failed.length) console.log(`  FAILED (${failed.length}):\n    ${failed.join('\n    ')}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
