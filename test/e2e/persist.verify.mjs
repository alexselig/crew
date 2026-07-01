// Proves session save/resume: launch the app, create + customize sessions,
// quit, then relaunch sharing the same user-data-dir and assert the workspace
// (agent, cwd, label, character) came back.  node test/e2e/persist.verify.mjs

import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const HOME = process.env.HOME || ROOT
const NODE_BIN = process.execPath
const DATA_DIR = '/tmp/crew-persist-test'

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}

async function waitUntil(fn, desc, timeout = 10000, interval = 200) {
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
    window.crew
      .getRoster()
      .then((r) =>
        r.map((s) => ({
          id: s.id,
          label: s.label,
          characterId: s.characterId,
          cwd: s.cwd,
          presetId: s.presetId,
          status: s.status
        }))
      )
  )

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true })

  // ---- Run 1: create + customize a workspace ----
  console.log('▶ Run 1 — build a workspace')
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })

  const made = await page.evaluate(
    async ({ node, home, root }) => {
      const a = await window.crew.createSession({
        presetId: 'shell',
        command: '/bin/bash',
        args: ['-l'],
        cwd: root,
        label: 'Build Shell'
      })
      const b = await window.crew.createSession({
        presetId: null,
        command: node,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: home,
        label: 'Fake Agent'
      })
      return [a.id, b.id]
    },
    { node: NODE_BIN, home: HOME, root: ROOT }
  )

  await waitUntil(async () => (await roster(page)).length >= 2, 'two sessions exist')
  // Rename one + change its character to prove those persist.
  await page.evaluate((id) => window.crew.rename(id, 'Renamed Session'), made[0])
  const chars = await page.evaluate(() => window.crew.getCharacters().then((c) => c.map((x) => x.id)))
  await page.evaluate(
    ({ id, cid }) => window.crew.setCharacter(id, cid),
    { id: made[1], cid: chars[7] } // pick a specific character
  )

  const before = (await roster(page))
    .map((s) => ({ label: s.label, characterId: s.characterId, cwd: s.cwd, presetId: s.presetId }))
    .sort((a, b) => a.label.localeCompare(b.label))
  console.log('  saved workspace:', JSON.stringify(before))
  await app.close()
  ok('Run 1 quit (sessions persisted to disk)')

  // ---- Run 2: relaunch, expect restore ----
  console.log('\n▶ Run 2 — relaunch and resume')
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })

  await waitUntil(async () => (await roster(page)).length === 2, 'sessions restored', 12000)
  const after = (await roster(page))
    .map((s) => ({ label: s.label, characterId: s.characterId, cwd: s.cwd, presetId: s.presetId, status: s.status }))
    .sort((a, b) => a.label.localeCompare(b.label))
  console.log('  restored workspace:', JSON.stringify(after))

  // All restored sessions should be live again.
  if (after.every((s) => s.status === 'active')) ok('restored sessions are live (re-launched)')
  else bad('some restored sessions are not active')

  // Compare the persisted fields.
  for (let i = 0; i < before.length; i++) {
    const b = before[i]
    const a = after[i]
    if (a && a.label === b.label && a.characterId === b.characterId && a.cwd === b.cwd && a.presetId === b.presetId) {
      ok(`resumed "${b.label}" (char=${b.characterId}, cwd=${b.cwd.split('/').pop()})`)
    } else {
      bad(`mismatch for "${b.label}": expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`)
    }
  }

  // Cleanup.
  await page.evaluate(async () => {
    const r = await window.crew.getRoster()
    for (const s of r) await window.crew.closeSession(s.id)
  })
  await app.close()
  rmSync(DATA_DIR, { recursive: true, force: true })

  console.log('\n================ PERSIST VERIFY ================')
  console.log(`failures: ${failures}`)
  console.log(failures ? '\n❌ FAILED' : '\n✅ SESSIONS SAVE & RESUME')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error('💥 harness error:', e)
  process.exit(1)
})
