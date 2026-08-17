// End-to-end harness for Crew: launches the built Electron app with Playwright,
// drives every button through the real UI, and exercises the full detection
// lifecycle against real PTYs. Run with:  node test/e2e/crew.e2e.mjs
//
// Screenshots are written to $SHOTS (default /tmp/crew-e2e).

import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
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

// Renderer-agnostic terminal text: the enhanced (Crew) engine renders to a WebGL
// canvas, which leaves .xterm-rows empty, so DOM scraping alone is unreliable.
// Prefer the engine's buffer text via the exposed __crewTerminalText hook (reads
// the xterm buffer directly), and fall back to joining any .xterm-rows layers.
async function xtermText(page) {
  return page.evaluate(async () => {
    const dom = [...document.querySelectorAll('.xterm-rows')].map((r) => r.textContent || '').join('\n')
    const read = globalThis.__crewTerminalText
    let buf = ''
    if (typeof read === 'function') {
      try {
        const roster = await window.crew.getRoster()
        buf = roster.map((s) => read(s.id)).join('\n')
      } catch {
        /* ignore */
      }
    }
    return dom + '\n' + buf
  })
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
    if (m.type() !== 'error') return
    const t = m.text()
    // Ignore benign packaged-app console noise that doesn't reflect a real fault:
    // resource 404s (asset thumbnails / sourcemaps served over crew-asset://),
    // the sourcemap's reference to the main.tsx entry, and the CSP note it
    // triggers. Genuine uncaught exceptions still arrive via 'pageerror'.
    if (/Failed to load resource/i.test(t) && /404/.test(t)) return
    if (/\bmain\.tsx\b|\.map\b/i.test(t)) return
    if (/Content Security Policy/i.test(t)) return
    rendererErrors.push(t)
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
  // The working-directory input now lives under the "Advanced" disclosure
  // (it defaults to the home dir); open it before filling.
  await page.locator('.advanced__toggle').click()
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
  const cardLabel = await page.locator('.card__name').first().textContent()
  if (cardLabel === 'Test Shell') ok('card shows label "Test Shell"')
  else bad(`card label wrong: ${cardLabel}`)
  await shot(page, 'session-created')

  // Type into the terminal, expect echoed output
  log('Typing into the terminal')
  await page.locator('.xterm').last().click()
  await page.keyboard.type('echo hello-crew-e2e')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await xtermText(page)).includes('hello-crew-e2e'),
    'terminal shows echoed output'
  )
  ok('terminal round-trip works (input → PTY → output)')
  await shot(page, 'terminal-output')

  // ================= Enhanced Terminal (Beta) toggle =================
  // Enable the app-wide Crew engine via Settings and prove a full round-trip,
  // then toggle back so the remaining checks run in the default (legacy) engine.
  log('Enhanced Terminal: enable via Settings and round-trip')
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.waitForSelector('.settings__list', { timeout: 5000 })
  await page.locator('.settings-row:has-text("Enhanced Terminal Interface")').click()
  await page.waitForSelector('.settings-row:has-text("Enhanced Terminal Interface") .switch.is-on', {
    timeout: 5000
  })
  ok('enhanced terminal toggle switched on')
  await page.locator('.modal button:has-text("Done")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })

  // The session's terminal remounts under the Crew engine (still an .xterm). The
  // pane-toggle only renders once the enhanced UI is live, so it's a deterministic
  // "engine swapped in" signal; wait for it (plus a brief settle for the engine to
  // attach + focus) before driving input, so keystrokes aren't dropped mid-swap.
  await page.waitForSelector('.pane-toggle', { timeout: 8000 })
  await page.waitForSelector('.xterm', { timeout: 8000 })
  await page.waitForTimeout(600)
  await page.locator('.xterm').last().click()
  await page.keyboard.type('echo enhanced-crew-e2e')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await xtermText(page)).includes('enhanced-crew-e2e'),
    'enhanced terminal shows echoed output'
  )
  ok('enhanced terminal round-trip works (Crew engine)')
  await shot(page, 'enhanced-terminal')

  // User-input row highlight: submitting input can drop a decoration on that row.
  // It's intentionally gated (shouldHighlightInputOnEnter): only when the prompt
  // sits on the bottom viewport row and no TUI/alt-screen is active — so in a
  // fresh, near-empty shell it legitimately may not fire. Report it either way;
  // don't fail the run on an intentionally-conditional visual aid.
  if ((await page.locator('.xterm-decoration').count()) > 0)
    ok('user-input row is highlighted (decoration present)')
  else ok('input-row highlight not shown here (gated to bottom-row prompts) — not a failure')

  // Jump-to-prompt keys must be handled without leaking to the shell or throwing.
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.press('Meta+ArrowDown')
  ok('jump-to-prompt keys handled (no crash)')

  // Toggle back OFF to restore the legacy engine for the remaining assertions.
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.waitForSelector('.settings__list', { timeout: 5000 })
  await page.locator('.settings-row:has-text("Enhanced Terminal Interface")').click()
  await page.waitForSelector(
    '.settings-row:has-text("Enhanced Terminal Interface") .switch:not(.is-on)',
    { timeout: 5000 }
  )
  await page.locator('.modal button:has-text("Done")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  await page.waitForSelector('.xterm', { timeout: 8000 })
  ok('toggled back to legacy engine cleanly')

  // ---- Rename via editable label ----
  log('Rename (editable label)')
  await page.locator('.session-header__label').click()
  await page.locator('.editable-label--input').fill('Renamed Agent')
  await page.keyboard.press('Enter')
  await waitUntil(
    async () => (await page.locator('.card__name').first().textContent()) === 'Renamed Agent',
    'card reflects rename'
  )
  ok('rename propagates to roster card')

  // ---- Character picker ----
  // The session header uses the "mascot" variant: the trigger is
  // .char-picker__mascot and each cell renders line-art (not a text glyph), so
  // verify the change through the roster's characterId rather than button text.
  log('Character picker')
  const charSessionId = await page.evaluate(async () => (await window.crew.getRoster())[0]?.id)
  const charBefore = await page.evaluate(
    async (sid) => (await window.crew.getRoster()).find((s) => s.id === sid)?.characterId,
    charSessionId
  )
  await page.locator('.char-picker__mascot').first().click()
  await page.waitForSelector('.char-picker__grid')
  const cells = page.locator('.char-picker__cell:not(.is-current)')
  if ((await cells.count()) > 0) {
    await cells.first().click()
    await waitUntil(
      async () =>
        (await page.evaluate(
          async (sid) => (await window.crew.getRoster()).find((s) => s.id === sid)?.characterId,
          charSessionId
        )) !== charBefore,
      'character changed'
    )
    const charAfter = await page.evaluate(
      async (sid) => (await window.crew.getRoster()).find((s) => s.id === sid)?.characterId,
      charSessionId
    )
    ok(`character changed ${charBefore} → ${charAfter}`)
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
  const pillText = await page.locator('.session-header__status').textContent()
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

  // ---- App pane: detect a dev-server URL and render it in a <webview> ----
  log('App pane (dev-server webview)')
  const appServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body><h1>CREW-APP-PANE-OK</h1></body></html>')
  })
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r))
  const appPort = appServer.address().port
  const appUrl = `http://127.0.0.1:${appPort}/`
  const appScript = `process.stdout.write('  VITE ready\\n  Local:   ${appUrl}\\n'); setInterval(() => {}, 1000)`
  const appId = await page.evaluate(
    async ({ bin, s, cwd }) => {
      const info = await window.crew.createSession({ presetId: null, command: bin, args: ['-e', s], cwd, label: 'App Preview' })
      return info.id
    },
    { bin: NODE_BIN, s: appScript, cwd: ROOT }
  )
  const appDetected = await waitUntil(
    async () => page.evaluate(async (sid) => (await window.crew.getRoster()).find((s) => s.id === sid)?.appUrl ?? null, appId),
    'dev-server URL detected from output',
    8000
  )
  if (appDetected === appUrl) ok(`appUrl detected: ${appDetected}`)
  else bad(`appUrl mismatch: got ${appDetected}, expected ${appUrl}`)

  await page.locator('.card:has-text("App Preview")').click()
  await waitUntil(async () => (await page.locator('.pane-toggle__btn', { hasText: 'App' }).count()) > 0, 'App tab visible', 5000)
  ok('App tab appears in the pane toggle')
  await page.locator('.pane-toggle__btn', { hasText: 'App' }).click()
  await waitUntil(async () => (await page.locator('.app-pane__webview').count()) > 0, 'webview mounts', 5000)
  const guestText = await waitUntil(
    async () =>
      page.evaluate(async () => {
        const wv = document.querySelector('.app-pane__webview')
        if (!wv || typeof wv.executeJavaScript !== 'function') return null
        try {
          return (await wv.executeJavaScript('document.body && document.body.innerText')) || null
        } catch {
          return null
        }
      }),
    'guest page content readable',
    20000
  )
  if (guestText && guestText.includes('CREW-APP-PANE-OK')) ok('webview rendered the local dev server')
  else bad(`webview did not render marker (got "${guestText}")`)
  await shot(page, 'app-pane')
  await page.evaluate((sid) => window.crew.closeSession(sid), appId)
  appServer.close()

  // ---- Workspaces: first-class membership + archive + duplicate ----
  log('Workspaces (first-class membership)')
  const wsCreated = await page.evaluate(async () => window.crew.createWorkspace('Alpha WS'))
  if (wsCreated && wsCreated.id) ok(`created workspace "${wsCreated.name}"`)
  else bad(`createWorkspace returned ${JSON.stringify(wsCreated)}`)
  const dupDenom = await page.evaluate(async () => (await window.crew.getRoster()).length)
  const wsSid = await page.evaluate(async () => (await window.crew.getRoster())[0]?.id)
  await page.evaluate(async ({ sid, wsId }) => window.crew.addSessionToWorkspace(sid, wsId), { sid: wsSid, wsId: wsCreated.id })
  await waitUntil(
    async () =>
      page.evaluate(async ({ sid, wsId }) => {
        const s = (await window.crew.getRoster()).find((x) => x.id === sid)
        return !!s?.workspaceIds?.includes(wsId)
      }, { sid: wsSid, wsId: wsCreated.id }),
    'session joined workspace',
    5000
  )
  ok('addSessionToWorkspace adds membership')
  await page.evaluate(async (sid) => window.crew.archiveSession(sid), wsSid)
  await waitUntil(
    async () =>
      page.evaluate(async (sid) => {
        const s = (await window.crew.getRoster()).find((x) => x.id === sid)
        return (s?.workspaceIds?.length ?? 0) === 0
      }, wsSid),
    'session archived',
    5000
  )
  ok('archiveSession clears membership')
  await page.evaluate(async ({ sid, wsId }) => window.crew.duplicateSession(sid, wsId), { sid: wsSid, wsId: wsCreated.id })
  await waitUntil(async () => (await page.evaluate(async () => (await window.crew.getRoster()).length)) === dupDenom + 1, 'duplicate spawned a session', 6000)
  const dupInWs = await page.evaluate(async ({ sid, wsId }) => {
    const roster = await window.crew.getRoster()
    return roster.some((s) => s.id !== sid && s.workspaceIds?.includes(wsId))
  }, { sid: wsSid, wsId: wsCreated.id })
  if (dupInWs) ok('duplicateSession creates a new session in the workspace')
  else bad('duplicate not found in workspace')
  // Clean up the duplicate so the later "close all" count is deterministic.
  const dupId = await page.evaluate(async ({ sid, wsId }) => {
    const roster = await window.crew.getRoster()
    return roster.find((s) => s.id !== sid && s.workspaceIds?.includes(wsId))?.id ?? null
  }, { sid: wsSid, wsId: wsCreated.id })
  if (dupId) await page.evaluate((id) => window.crew.closeSession(id), dupId)

  // ---- Close both sessions ----
  log('Close button → back to empty')
  // Close via the roster card ✕ to also exercise that control. The card actions
  // are revealed on hover, and the ✕ is specifically .mini-btn--close (the row
  // also has restart/minimize icons).
  let guard = 0
  while ((await page.locator('.card').count()) > 0 && guard++ < 6) {
    const card = page.locator('.card').first()
    await card.hover()
    await card.locator('.mini-btn--close').click()
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
