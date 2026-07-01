// Verifies every built-in preset (Claude Code, Copilot CLI, Shell) actually
// launches through the real app without the "failed to launch" error pane.
// Runs in an isolated --user-data-dir so it won't disturb a running Crew.
//   node test/e2e/agents.verify.mjs

import { _electron as electron } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-agents'
mkdirSync(SHOTS, { recursive: true })
const ROOT = resolve(process.cwd())
const HOME = process.env.HOME || ROOT

let failures = 0
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  failures++
  console.log(`  ✗ ${m}`)
}

async function waitUntil(fn, desc, timeout = 8000, interval = 200) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`timeout: ${desc}`)
}

async function launchPreset(page, presetValue, label) {
  await page.locator('.roster__header button:has-text("New Session")').click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.locator('.modal select.field__input').selectOption(presetValue)
  await page.locator('.field:has(.field__label:has-text("Working directory")) input').fill(HOME)
  await page.locator('.field:has(.field__label:has-text("Label")) input').fill(label)
  await page.locator('.modal button:has-text("Launch")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
}

async function sessionByLabel(page, label) {
  return page.evaluate(async (l) => {
    const r = await window.crew.getRoster()
    const s = r.find((x) => x.label === l)
    return s ? { state: s.state, status: s.status, pid: s.pid, err: s.errorMessage ?? null } : null
  }, label)
}

async function main() {
  console.log('Launching isolated Crew instance…')
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), '--user-data-dir=/tmp/crew-verify'],
    cwd: ROOT
  })
  const page = await app.firstWindow()
  const rendererErrors = []
  page.on('pageerror', (e) => rendererErrors.push(String(e)))
  await page.waitForSelector('.app', { timeout: 10000 })

  const cases = [
    ['shell', 'Shell Check'],
    ['claude-code', 'Claude Check'],
    ['copilot-cli', 'Copilot Check']
  ]

  for (const [preset, label] of cases) {
    console.log(`\n▶ ${label} (${preset})`)
    await launchPreset(page, preset, label)
    await waitUntil(async () => (await sessionByLabel(page, label)) !== null, `${label} appears`)

    // Give the agent a few seconds to boot its TUI, then require it to be a
    // live session (i.e. the binary spawned) — not the red ERROR pane.
    let info
    try {
      await waitUntil(async () => {
        info = await sessionByLabel(page, label)
        return info && info.status === 'active' && info.state !== 'STARTING'
      }, `${label} becomes active`, 8000)
    } catch {
      info = await sessionByLabel(page, label)
    }

    await page.locator(`.card:has-text("${label}")`).click()
    await new Promise((r) => setTimeout(r, 1500))
    await page.screenshot({ path: join(SHOTS, `${preset}.png`) })

    if (info && info.status === 'active') {
      ok(`${label} launched (state=${info.state}, pid=${info.pid})`)
    } else {
      bad(`${label} did NOT launch cleanly: ${JSON.stringify(info)}`)
    }
  }

  // Clean up spawned agent processes.
  await page.evaluate(async () => {
    const r = await window.crew.getRoster()
    for (const s of r) await window.crew.closeSession(s.id)
  })

  await app.close()

  console.log('\n================ AGENT VERIFY ================')
  console.log(`renderer errors: ${rendererErrors.length}`)
  rendererErrors.forEach((e) => console.log('   ! ' + e))
  console.log(`failures: ${failures}`)
  console.log(failures || rendererErrors.length ? '\n❌ FAILED' : '\n✅ ALL PRESETS LAUNCH')
  process.exit(failures || rendererErrors.length ? 1 : 0)
}

main().catch((e) => {
  console.error('💥 harness error:', e)
  process.exit(1)
})
