// Repro: does terminal input get stuck / lose focus after switching sessions,
// opening modals, or toggling grid? Reports what's focused and whether typed
// input actually reaches each PTY.
import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-focusbug'
const sh = '/bin/bash'
let failures = 0

async function activeEl(page) {
  return page.evaluate(() => {
    const a = document.activeElement
    return a ? `${a.tagName.toLowerCase()}.${(a.className || '').toString().split(' ')[0]}` : 'none'
  })
}
async function tailText(page) {
  return (await page.locator('.session-body .xterm-rows').textContent().catch(() => '')) || ''
}
async function typeNoClick(page, marker) {
  // Type WITHOUT clicking the terminal first — tests whether focus auto-lands there.
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  return (await tailText(page)).includes(marker)
}

async function main() {
  rmSync(DATA, { recursive: true, force: true })
  const app = await electron.launch({ args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`], cwd: ROOT })
  const page = await app.firstWindow()
  await page.waitForSelector('.app')

  const ids = await page.evaluate(
    async ({ shell, cwd }) => {
      const a = await window.crew.createSession({ presetId: 'shell', command: shell, args: ['-l'], cwd, label: 'Alpha' })
      const b = await window.crew.createSession({ presetId: 'shell', command: shell, args: ['-l'], cwd, label: 'Bravo' })
      return [a.id, b.id]
    },
    { shell: sh, cwd: ROOT }
  )
  await page.waitForSelector('.xterm')
  await page.waitForTimeout(1500)

  async function step(name, selectLabel) {
    if (selectLabel) {
      await page.locator(`.roster__list .card:has-text("${selectLabel}")`).click()
      await page.waitForTimeout(600)
    }
    const focused = await activeEl(page)
    const marker = 'MK_' + name
    const reached = await typeNoClick(page, marker)
    if (!reached) failures++
    console.log(`  ${reached ? '✓' : '✗'} ${name.padEnd(16)} focus=${focused.padEnd(28)} input ${reached ? 'reached PTY' : 'STUCK'}`)
    return reached
  }

  console.log('Session A selected by default:')
  await step('initial-A')            // A just created/selected
  console.log('Switch to B:')
  await step('switch-B', 'Bravo')
  console.log('Switch back to A:')
  await step('switchback-A', 'Alpha')

  console.log('Open + close Settings, then type:')
  await page.locator('.icon-btn[title="Settings"]').click()
  await page.waitForSelector('.settings-row')
  await page.locator('.modal .btn--primary').click()
  await page.waitForTimeout(300)
  await step('after-settings')

  console.log('Open + close palette (Cmd-K, Esc), then type:')
  await page.keyboard.press('Meta+k')
  await page.waitForSelector('.palette')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await step('after-palette')

  console.log('Toggle grid then back to single, then type:')
  await page.locator('.view-toggle__btn').nth(1).click()
  await page.waitForTimeout(500)
  // grid auto-collapses the nav; return to focus view via the collapsed rail button
  await page.locator('.roster__collapsed-head .icon-btn[title="Switch to focus view"]').click()
  await page.waitForTimeout(500)
  await step('after-grid')

  await app.close()
  rmSync(DATA, { recursive: true, force: true })
  console.log(`\nfailures: ${failures}`)
  console.log(failures ? '❌ INPUT-FOCUS REGRESSION' : '✅ TERMINAL KEEPS FOCUS AFTER OVERLAYS')
  process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
