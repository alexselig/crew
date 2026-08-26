// Regression guard for the 2026-08-25 roster wipe: an agent that DIES must not
// be erased from the saved session list.
//
// What broke: persistSessions() saved only sessions whose status was 'active',
// and proc.onExit() called it. So when an external failure killed the agents
// (that night: an expired OCV MCP OAuth token 401-ing every Copilot launch),
// each death rewrote crew-store.json without that session — permanently. A
// roster of 46 sessions shrank to 12 across a few relaunches.
//
// Intentional removal goes through close(), which deletes the entry outright,
// so "still on the roster" is the correct thing to persist — not "still alive".
//
//   node test/e2e/agent-death-persist.verify.mjs

import { _electron as electron } from 'playwright'
import { rmSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const HOME = process.env.HOME || ROOT
const NODE_BIN = process.execPath
const DATA_DIR = '/tmp/crew-agent-death-test'
const STORE = join(DATA_DIR, 'crew-store.json')

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}

async function waitUntil(fn, desc, timeout = 15000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timeout: ${desc}`)
}

function launch() {
  return electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
}

const roster = (page) =>
  page.evaluate(() =>
    window.crew.getRoster().then((r) => r.map((s) => ({ id: s.id, label: s.label, status: s.status })))
  )

const persistedLabels = () => {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8')).sessions.map((s) => s.label).sort()
  } catch {
    return []
  }
}

const storeMtime = () => {
  try {
    return statSync(STORE).mtimeMs
  } catch {
    return 0
  }
}

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })

  // ---- Run 1: one healthy session, one that dies on its own ----
  console.log('▶ Run 1 — a surviving agent and a dying agent')
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 15000 })

  await page.evaluate(
    async ({ node, home }) => {
      await window.crew.createSession({
        presetId: null,
        command: node,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: home,
        label: 'Survivor'
      })
      await window.crew.createSession({
        presetId: null,
        command: node,
        // Exits non-zero almost immediately — stands in for a Copilot process
        // killed at startup by a failing MCP server.
        args: ['-e', 'setTimeout(()=>process.exit(1),400)'],
        cwd: home,
        label: 'Doomed'
      })
    },
    { node: NODE_BIN, home: HOME }
  )

  await waitUntil(async () => (await roster(page)).length === 2, 'two sessions exist')
  // Baseline the store *before* the death, so the snapshot we assert on is the
  // one the exit handler wrote and not an earlier save.
  const beforeDeath = storeMtime()
  await waitUntil(
    async () => (await roster(page)).some((s) => s.label === 'Doomed' && s.status !== 'active'),
    'the doomed agent has died'
  )
  ok('"Doomed" agent exited (status is no longer active)')

  // The store is rewritten by the exit handler — this is the exact moment the
  // old code dropped the session. That write is asynchronous, so wait for it
  // instead of sampling once: on a loaded machine a single read lands before
  // the write and reports an empty store, which looks like a failure but is
  // only a race in the test.
  await waitUntil(() => storeMtime() > beforeDeath, 'store rewritten after the agent died')
  const saved = persistedLabels()
  console.log('  persisted after death:', JSON.stringify(saved))
  if (saved.includes('Doomed')) ok('dead session SURVIVES in crew-store.json')
  else bad('dead session was erased from crew-store.json (the regression)')
  if (saved.includes('Survivor')) ok('live session still persisted')
  else bad('live session missing from crew-store.json')

  await app.close()

  // ---- Run 2: relaunch — both must come back ----
  console.log('\n▶ Run 2 — relaunch and expect BOTH back')
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 15000 })

  await waitUntil(async () => (await roster(page)).length === 2, 'both sessions restored')
  const labels = (await roster(page)).map((s) => s.label).sort()
  console.log('  restored roster:', JSON.stringify(labels))
  if (labels.join(',') === 'Doomed,Survivor') ok('both sessions restored after a crash')
  else bad(`expected Doomed,Survivor — got ${labels.join(',')}`)

  // ---- Closing a session must still remove it for real ----
  console.log('\n▶ Run 3 — explicit close still removes')
  const target = (await roster(page)).find((s) => s.label === 'Survivor')
  await page.evaluate((id) => window.crew.closeSession(id), target.id)
  await waitUntil(async () => !persistedLabels().includes('Survivor'), 'closed session dropped')
  ok('explicitly closed session IS removed from the store')

  await page.evaluate(async () => {
    const r = await window.crew.getRoster()
    for (const s of r) await window.crew.closeSession(s.id)
  })
  await app.close()
  rmSync(DATA_DIR, { recursive: true, force: true })

  console.log('\n============ AGENT-DEATH PERSIST VERIFY ============')
  console.log(`failures: ${failures}`)
  console.log(failures ? '\n❌ FAILED' : '\n✅ A DYING AGENT NEVER LOSES ITS SESSION')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
