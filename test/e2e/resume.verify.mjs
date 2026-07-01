// Verifies agent-native resume: on restore, a preset with resumeArgs is
// relaunched with --continue, but the persisted/displayed args are NOT changed
// (so it never accumulates). Uses a node "agent" that echoes its argv.
import { _electron as electron } from 'playwright'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const NODE = process.execPath
const DATA = '/tmp/crew-resume-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 10000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)) } throw new Error('timeout ' + d) }
const launch = () => electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
const tail = (page) => page.locator('.session-body .xterm-rows').textContent().catch(() => '')
// A script-file "agent" that echoes the args it was launched with.
const AGENT = '/tmp/crew-fake-agent.js'

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  writeFileSync(AGENT, "process.stdout.write('ARGV='+JSON.stringify(process.argv.slice(2))+'\\n'); setInterval(()=>{},1000)")

  // Run 1: fresh create under the claude-code preset (has resumeArgs) but with a
  // node command so we can read argv. No --continue on first launch.
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForSelector('.app')
  await page.evaluate(
    async ({ node, agent, cwd }) => {
      await window.crew.createSession({ presetId: 'claude-code', command: node, args: [agent], cwd, label: 'Resumer' })
    },
    { node: NODE, agent: AGENT, cwd: ROOT }
  )
  await waitUntil(async () => (await tail(page)).includes('ARGV='), 'first launch printed argv')
  const first = await tail(page)
  if (first.includes('ARGV=[]')) ok('fresh launch has NO --continue')
  else bad(`fresh launch argv unexpected: ${first.match(/ARGV=[^\n]*/)?.[0]}`)
  await app.close()

  // Run 2: relaunch → restore should add --continue.
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.app')
  await waitUntil(async () => (await page.locator('.card').count()) === 1, 'session restored')
  await waitUntil(async () => (await tail(page)).includes('--continue'), 'restored launch has --continue', 12000)
  ok('restored session relaunched with --continue')

  const args = await page.evaluate(() => window.crew.getRoster().then((r) => r[0]?.args))
  if (JSON.stringify(args) === JSON.stringify([AGENT])) ok('persisted args unchanged (no --continue accumulation)')
  else bad(`args accumulated/changed: ${JSON.stringify(args)}`)

  await page.evaluate(async () => { const r = await window.crew.getRoster(); for (const s of r) await window.crew.closeSession(s.id) })
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  rmSync(AGENT, { force: true })
  console.log(`\nfailures: ${failures}`)
  console.log(failures ? '❌ FAILED' : '✅ AGENT-NATIVE RESUME WORKS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
