// Verifies smart approvals: a y/n prompt is detected as WAITING_APPROVAL, the
// approval bar appears, and clicking Approve sends the keystrokes to the agent.
import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const NODE_BIN = process.execPath
const DATA = '/tmp/crew-approve-data'
let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => { failures++; console.log(`  ✗ ${m}`) }
async function waitUntil(fn, desc, t = 10000) {
  const s = Date.now()
  while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)) }
  throw new Error('timeout: ' + desc)
}

const script =
  "process.stdout.write('Allow edit to file.txt? (y/n) '); process.stdin.on('data',d=>{if(String(d).includes('y'))process.stdout.write('\\nAPPROVED-OK\\n')}); process.stdin.resume();"

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  // Use the shell preset (which carries an approval regex) but run our fake prompt.
  const id = await page.evaluate(
    async ({ node, s, cwd }) => {
      const info = await window.crew.createSession({ presetId: 'shell', command: node, args: ['-e', s], cwd, label: 'Approver' })
      return info.id
    },
    { node: NODE_BIN, s: script, cwd: ROOT }
  )

  await waitUntil(async () => {
    const r = await page.evaluate((sid) => window.crew.getRoster().then((x) => x.find((s) => s.id === sid)?.state), id)
    return r === 'WAITING_APPROVAL'
  }, 'agent → WAITING_APPROVAL', 8000)
  ok('y/n prompt detected as WAITING_APPROVAL')

  await page.locator('.card:has-text("Approver")').click()
  await waitUntil(async () => (await page.locator('.approval-bar').count()) === 1, 'approval bar visible')
  ok('approval bar shown with Approve/Deny')

  await page.locator('.approval-bar .btn--approve').click()
  await waitUntil(
    async () => ((await page.locator('.session-body .xterm-rows').textContent()) || '').includes('APPROVED-OK'),
    'agent received the approval keystrokes'
  )
  ok('clicking Approve sent the keys (agent responded APPROVED-OK)')

  await page.evaluate((sid) => window.crew.closeSession(sid), id)
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ APPROVALS WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
