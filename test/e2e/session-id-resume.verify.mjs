// Verifies per-session resume: a preset with sessionIdFlag (Copilot) launches
// with --session-id=<uuid>, that id is saved into a set, and resuming the set
// relaunches with the SAME id (reattaching the same conversation).
//   node test/e2e/session-id-resume.verify.mjs
import { _electron as electron } from 'playwright'
import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-sid-data'
const AGENT = '/tmp/crew-argv-agent.js'
const LOG = '/tmp/crew-argv.log'
rmSync(DATA, { recursive: true, force: true })
writeFileSync(LOG, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fail = 0
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => { fail++; console.log('  \u2717 ' + m) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const active = async (page) =>
  (await page.evaluate(() => window.crew.getRoster())).filter((s) => s.status === 'active')

async function main() {
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`],
    cwd: ROOT,
    env: { ...process.env, CREW_NO_QUIT_CONFIRM: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })

  // Copilot preset (has sessionIdFlag) but with a harmless node agent.
  await page.evaluate(
    ({ AGENT, cwd }) =>
      window.crew.createSession({ presetId: 'copilot-cli', command: 'node', args: [AGENT], cwd, label: 'Sess' }),
    { AGENT, cwd: ROOT }
  )
  await sleep(800)
  let a = await active(page)
  const sid = a[0]?.agentSessionId
  UUID.test(sid || '') ? ok(`session got a UUID agentSessionId (${sid.slice(0, 8)}\u2026)`) : bad(`no/invalid agentSessionId: ${sid}`)

  let log = readFileSync(LOG, 'utf8')
  log.includes(`--session-id=${sid}`) ? ok('launched with --session-id=<uuid>') : bad(`argv missing --session-id: ${JSON.stringify(log)}`)

  // Save as a set -> id must be stored
  await page.evaluate(() => window.crew.saveSet('S'))
  const sets = await page.evaluate(() => window.crew.getSets())
  const stored = sets.find((s) => s.name === 'S')?.sessions?.[0]?.agentSessionId
  stored === sid ? ok('set stored the agentSessionId') : bad(`set stored wrong id: ${stored} vs ${sid}`)

  // Close, then resume the set
  for (const s of a) await page.evaluate((id) => window.crew.closeSession(id), s.id)
  await sleep(500)
  writeFileSync(LOG, '') // clear so we only see the resume launch
  await page.evaluate(() => window.crew.launchSet('S'))
  await sleep(1000)
  a = await active(page)
  a.length === 1 ? ok('resumed set spawned 1 session') : bad(`expected 1 active, got ${a.length}`)
  a[0]?.agentSessionId === sid ? ok('resumed session reuses the SAME agentSessionId') : bad(`resumed id changed: ${a[0]?.agentSessionId} vs ${sid}`)
  log = readFileSync(LOG, 'utf8')
  log.includes(`--session-id=${sid}`) ? ok('resume relaunched with --session-id=<same uuid> \u2192 RESUMES SAME SESSION') : bad(`resume argv missing same id: ${JSON.stringify(log)}`)

  await app.close()
  console.log(fail ? '\n\u274c FAILED' : '\n\u2705 per-session resume works')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
