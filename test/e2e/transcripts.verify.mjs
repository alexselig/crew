import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const NODE = process.execPath
const DATA = '/tmp/crew-transcripts-data'
let failures = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { failures++; console.log('  ✗ ' + m) }
async function waitUntil(fn, d, t = 10000) { const s = Date.now(); while (Date.now() - s < t) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)) } throw new Error('timeout ' + d) }

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.waitForSelector('.app')

  const MARKER = 'ZORKMID_TRANSCRIPT_' + Date.now()

  // capture is opt-in: session created BEFORE enabling must not be recorded
  await page.evaluate(() => window.crew.updateSettings({ captureTranscripts: false }))
  const offScript = `process.stdout.write('SHOULD_NOT_CAPTURE\\nReady\\n> '); setInterval(()=>{},1000)`
  const offId = await page.evaluate(
    async ({ node, s, cwd }) => (await window.crew.createSession({ presetId: null, command: node, args: ['-e', s], cwd, label: 'Off' })).id,
    { node: NODE, s: offScript, cwd: ROOT }
  )
  await page.waitForTimeout(800)

  // now enable capture, then create a session that prints the unique marker
  await page.evaluate(() => window.crew.updateSettings({ captureTranscripts: true }))
  const onScript = `process.stdout.write('${MARKER}\\nReady\\n> '); setInterval(()=>{},1000)`
  const onId = await page.evaluate(
    async ({ node, s, cwd }) => (await window.crew.createSession({ presetId: null, command: node, args: ['-e', s], cwd, label: 'Recorder' })).id,
    { node: NODE, s: onScript, cwd: ROOT }
  )

  // getTranscript flushes the buffer; wait until the marker lands on disk
  await waitUntil(async () => {
    const txt = await page.evaluate((sid) => window.crew.getTranscript(sid), onId)
    return (txt || '').includes(MARKER)
  }, 'marker written to transcript')
  ok('getTranscript returns captured output')

  // search finds the marker and attributes it to the recording session
  const matches = await page.evaluate((q) => window.crew.searchTranscripts(q), MARKER)
  const hit = matches.find((m) => m.sessionId === onId && m.line.includes(MARKER))
  if (hit) ok(`searchTranscripts found the marker (line ${hit.lineNo})`)
  else bad(`searchTranscripts missed the marker: ${JSON.stringify(matches)}`)

  // the opt-out session must have no transcript at all
  const offTxt = await page.evaluate((sid) => window.crew.getTranscript(sid), offId)
  if (!offTxt.includes('SHOULD_NOT_CAPTURE')) ok('capture is opt-in: disabled session was not recorded')
  else bad('opt-out session was recorded despite captureTranscripts=false')

  // UI: palette action opens the Transcripts modal and search works there
  await page.keyboard.press('Meta+k')
  await page.waitForSelector('.palette')
  await page.locator('.palette__item:has-text("Search transcripts")').click()
  await page.waitForSelector('.transcript-results')
  await page.locator('.modal--wide .field__input').fill(MARKER)
  await waitUntil(async () => (await page.locator('.transcript-row').count()) > 0, 'modal shows results')
  const rowText = await page.locator('.transcript-row').first().textContent()
  if ((rowText || '').includes('Recorder')) ok('Transcripts modal shows matches with session label')
  else bad(`modal row missing label: ${rowText}`)
  await page.locator('.modal--wide .btn--primary').click()

  await page.evaluate((sid) => window.crew.closeSession(sid), onId)
  await page.evaluate((sid) => window.crew.closeSession(sid), offId)
  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nrenderer errors: ${errs.length}, failures: ${failures}`)
  console.log(failures || errs.length ? '❌ FAILED' : '✅ TRANSCRIPT CAPTURE + SEARCH WORK')
  process.exit(failures || errs.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
