import { _electron as electron } from 'playwright'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('/Users/alexselig/crew')
const DATA = '/tmp/crew-shutdown-data'
rmSync(DATA, { recursive: true, force: true })

async function main() {
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA}`],
    cwd: ROOT
  })

  let stderr = ''
  app.process().stderr?.on('data', (d) => (stderr += d.toString()))
  app.process().stdout?.on('data', (d) => (stderr += d.toString()))

  const page = await app.firstWindow()
  await page.waitForSelector('.app', { timeout: 10000 })

  // Launch a real shell session so quit has a live PTY to kill (that async exit
  // is what used to re-emit a roster into a destroyed tray).
  await page.locator('.roster__header button:has-text("New Session")').first().click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.locator('.modal select.field__input').selectOption('shell')
  await page.locator('.field:has(.field__label:has-text("Working directory")) input').fill(ROOT)
  await page.locator('.field:has(.field__label:has-text("Label")) input').fill('ShutdownTest')
  await page.locator('.modal button:has-text("Launch")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  await page.waitForSelector('.card', { timeout: 8000 })
  await new Promise((r) => setTimeout(r, 800))

  await app.close()
  await new Promise((r) => setTimeout(r, 500))

  const bad = /Tray is destroyed|Uncaught Exception/i.test(stderr)
  if (bad) {
    console.log('❌ shutdown race still present:\n' + stderr.split('\n').filter((l) => /Tray|Uncaught|Error/i.test(l)).join('\n'))
    process.exit(1)
  }
  console.log('✅ clean shutdown with a live session — no "Tray is destroyed"')
  rmSync(DATA, { recursive: true, force: true })
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
