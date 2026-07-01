// End-to-end harness for Crew: launches the built Electron app with Playwright,
// drives every button through the real UI, and exercises the full detection
// lifecycle against real PTYs. Run with:  node test/e2e/crew.e2e.mjs
//
// Screenshots are written to $SHOTS (default /tmp/crew-e2e).

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-e2e'
mkdirSync(SHOTS, { recursive: true })

const NODE_BIN = process.execPath // absolute path to node — safe inside the PTY
const ROOT = resolve(process.cwd())
// Isolated user-data dir so the test never reads/writes the real app's store
// (which now persists sessions for resume) and always starts from empty.
const DATA_DIR = '/tmp/crew-e2e-data'
rmSync(DATA_DIR, { recursive: true, force: true })

const rendererErrors = []
const mainErrors = []
let shotN = 0
let failures = 0

function log(msg) {
  console.log(`\n▶ ${msg}`)
}
function ok(msg) {
  console.log(`  ✓ ${msg}`)
}
function bad(msg) {
  failures++
  console.log(`  ✗ ${msg}`)
}

async function shot(page, name) {
  const file = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  console.log(`  📸 ${file}`)
}

async function waitUntil(fn, desc, timeout = 10000, interval = 150) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = e
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timeout waiting for: ${desc} (last=${JSON.stringify(last)})`)
}

async function rosterState(page, id) {
  return page.evaluate(async (sid) => {
    const r = await window.crew.getRoster()
    return r.find((s) => s.id === sid)?.state ?? null
  }, id)
}

async function main() {
  log('Launching Crew (Electron)…')
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })

  const proc = app.process()
  proc.stderr?.on('data', (d) => {
    const s = d.toString()
    if (/error|exception|throw/i.test(s)) mainErrors.push(s.trim())
  })

  const page = await app.firstWindow()
  page.on('pageerror', (e) => rendererErrors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') rendererErrors.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.app', { timeout: 10000 })
  ok('window loaded, .app present')
  await shot(page, 'empty')

  // ---- Empty state ----
  log('Empty state')
  const emptyText = await page.locator('.empty h2').textContent()
  if (emptyText && /No session/i.test(emptyText)) ok('empty state shown')
  else bad(`empty state missing (got: ${emptyText})`)

  // ================= UI PATH: New Session via modal (Shell) =================
  log('New Session button → modal')
  await page.locator('.roster__header button:has-text("New Session")').click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  ok('modal opened')
  await shot(page, 'modal')

  // Select Shell preset, set cwd + label
  await page.locator('.modal select.field__input').selectOption('shell')
  const cwdInput = page.locator('.field:has(.field__label:has-text("Working directory")) input')
  await cwdInput.fill(ROOT)
  const labelInput = page.locator('.field:has(.field__label:has-text("Label")) input')
  await labelInput.fill('Test Shell')
  await page.locator('.modal button:has-text("Launch")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  ok('modal submitted + closed')

  // Card + terminal appear
  await page.waitForSelector('.card', { timeout: 8000 })
  await page.waitForSelector('.xterm', { timeout: 8000 })
  const cardLabel = await page.locator('.card__label').first().textContent()
  if (cardLabel === 'Test Shell') ok('card shows label "Test Shell"')
  else bad(`card label wrong: ${cardLabel}`)
  await shot(page, 'session-created')

  // Type into the terminal, expect echoed output
  log('Typing into the terminal')
  await page.locator('.xterm').click()
  await page.keyboard.type('echo hello-crew-e2e')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await page.locator('.xterm-rows').textContent())?.includes('hello-crew-e2e'),
    'terminal shows echoed output'
  )
  ok('terminal round-trip works (input → PTY → output)')
  await shot(page, 'terminal-output')

  // ---- Rename via editable label ----
  log('Rename (editable label)')
  await page.locator('.session-header__label').click()
  await page.locator('.editable-label--input').fill('Renamed Agent')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await page.locator('.card__label').first().textContent()) === 'Renamed Agent',
    'card reflects rename'
  )
  ok('rename propagates to roster card')

  // ---- Character picker ----
  log('Character picker')
  const glyphBefore = await page.locator('.char-picker__btn').textContent()
  await page.locator('.char-picker__btn').click()
  await page.waitForSelector('.char-picker__grid')
  // pick a cell that isn't the current one
  const cells = page.locator('.char-picker__cell')
  const count = await cells.count()
  let picked = false
  for (let i = 0; i < count; i++) {
    const g = await cells.nth(i).textContent()
    if (g !== glyphBefore) {
      await cells.nth(i).click()
      picked = true
      break
    }
  }
  if (picked) {
    await waitUntil(
      async () => (await page.locator('.char-picker__btn').textContent()) !== glyphBefore,
      'character glyph changed'
    )
    ok(`character changed ${glyphBefore} → ${await page.locator('.char-picker__btn').textContent()}`)
  } else bad('no alternate character to pick')

  // ================= DETECTION E2E: WORKING → WAITING → WORKING =================
  log('Detection lifecycle (custom node agent)')
  const script =
    "process.stdout.write('thinking...\\n'); setTimeout(() => process.stdout.write('Ready. Ask me something.\\n> '), 200); setInterval(() => {}, 1000)"
  const id = await page.evaluate(
    async ({ bin, s, cwd }) => {
      const info = await window.crew.createSession({
        presetId: null,
        command: bin,
        args: ['-e', s],
        cwd,
        label: 'Fake Agent'
      })
      return info.id
    },
    { bin: NODE_BIN, s: script, cwd: ROOT }
  )
  ok(`spawned fake agent session ${id.slice(0, 8)}`)

  // It streams then goes quiet → should land in WAITING_INPUT via the fallback.
  await waitUntil(async () => (await rosterState(page, id)) === 'WAITING_INPUT', 'agent → WAITING_INPUT', 6000)
  ok('agent detected as WAITING_INPUT after quiescence')
  // select it and screenshot the red-dot waiting state
  await page.locator('.card:has-text("Fake Agent")').click()
  await shot(page, 'waiting-state')
  const pillText = await page.locator('.pill').textContent()
  if (/waiting/i.test(pillText || '')) ok(`state pill shows "${pillText}"`)
  else bad(`pill not waiting: ${pillText}`)

  // Send input → back to WORKING
  await page.evaluate((sid) => window.crew.sendInput(sid, 'hello\r'), id)
  await waitUntil(async () => (await rosterState(page, id)) === 'WORKING', 'agent → WORKING after input', 4000)
  ok('sending input returns agent to WORKING')

  // Issue-1 regression: right after input, terminal echo + silent think-time
  // must NOT be misread as a red dot. Within the post-input grace window the
  // agent stays WORKING (the old code flipped to WAITING ~1.5s after the echo).
  await page.waitForTimeout(1900)
  const afterEcho = await rosterState(page, id)
  if (afterEcho === 'WORKING') ok('stays WORKING through post-input echo + think-time (no false red dot)')
  else bad(`regressed: went ${afterEcho} during post-input grace window`)

  // roster should now sort the waiting/working appropriately and show 2 cards
  const cardCount = await page.locator('.card').count()
  if (cardCount === 2) ok('roster shows both sessions')
  else bad(`expected 2 cards, got ${cardCount}`)
  await shot(page, 'two-sessions')

  // ---- Restart ----
  log('Restart button')
  await page.locator('.card:has-text("Test Shell"), .card:has-text("Renamed Agent")').first().click()
  const pidBefore = await page.evaluate(async () => {
    const r = await window.crew.getRoster()
    return r.find((s) => s.label === 'Renamed Agent')?.pid ?? null
  })
  await page.locator('.session-header button:has-text("Restart")').click()
  await waitUntil(async () => {
    const pid = await page.evaluate(async () => {
      const r = await window.crew.getRoster()
      return r.find((s) => s.label === 'Renamed Agent')?.pid ?? null
    })
    return pid && pid !== pidBefore
  }, 'restart produces a new pid')
  ok('restart spawns a fresh process (new pid)')
  await page.waitForSelector('.xterm', { timeout: 5000 })
  ok('terminal present after restart')

  // ---- Close both sessions ----
  log('Close button → back to empty')
  // close via the roster card ✕ to also exercise that control
  let guard = 0
  while ((await page.locator('.card').count()) > 0 && guard++ < 6) {
    await page.locator('.card .mini-btn--icon').first().click()
    await page.waitForTimeout(250)
  }
  await waitUntil(async () => (await page.locator('.card').count()) === 0, 'all cards closed')
  await page.waitForSelector('.empty', { timeout: 5000 })
  ok('closing all sessions returns to empty state')
  await shot(page, 'empty-again')

  // ---- Error path: bad command ----
  log('Error handling (nonexistent command)')
  const errId = await page.evaluate(async ({ cwd }) => {
    const info = await window.crew.createSession({
      presetId: null,
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
      cwd
    })
    return info.id
  }, { cwd: ROOT })
  const errState = await waitUntil(async () => {
    const st = await rosterState(page, errId)
    return st === 'ERROR' ? st : null
  }, 'bad command → ERROR', 5000)
  ok(`nonexistent command surfaces as ${errState} (no crash)`)
  await page.locator('.card:has-text("ERROR"), .card').first().click()
  await shot(page, 'error-state')
  await page.evaluate((sid) => window.crew.closeSession(sid), errId)

  log('Closing app')
  await app.close()

  // ---- Report ----
  console.log('\n================ E2E REPORT ================')
  console.log(`renderer errors: ${rendererErrors.length}`)
  rendererErrors.forEach((e) => console.log('   ! ' + e))
  console.log(`main-process errors: ${mainErrors.length}`)
  mainErrors.forEach((e) => console.log('   ! ' + e))
  console.log(`assertion failures: ${failures}`)
  const didFail = failures > 0 || rendererErrors.length > 0
  console.log(didFail ? '\n❌ E2E FAILED' : '\n✅ E2E PASSED')
  process.exit(didFail ? 1 : 0)
}

main().catch((e) => {
  console.error('\n💥 E2E harness error:', e)
  process.exit(1)
})
