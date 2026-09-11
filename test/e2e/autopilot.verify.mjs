import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const data = mkdtempSync(join(tmpdir(), 'crew-autopilot-ui-'))
const command = join(data, 'fake-copilot')
writeFileSync(command, '#!/bin/sh\nwhile :; do printf "working\\r"; sleep 0.2; done\n', { mode: 0o700 })
const mode = (newMode) => JSON.stringify({ type: 'session.mode_changed', data: { newMode } })
let app
const launch = () => electron.launch({
  args: [join(root, 'out/main/index.js'), `--user-data-dir=${join(data, 'profile')}`],
  cwd: root,
  env: { ...process.env, HOME: data }
})

try {
  app = await launch()
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForSelector('.app')
  await page.evaluate(() => {
    window.modeUpdates = []
    window.crew.onRoster((roster) => {
      window.modeUpdates.push(roster.map(({ id, state, autopilot }) => ({ id, state, autopilot })))
    })
  })
  const workspace = await page.evaluate(() => window.crew.createWorkspace('Autopilot fixtures'))
  assert(workspace)
  const session = await page.evaluate(({ command, data, workspaceId }) => window.crew.createSession({
    presetId: 'copilot-cli', command, args: ['--model', 'gpt-6-astra'],
    cwd: data, label: 'Autopilot regression fixture', workspaceIds: [workspaceId]
  }), { command, data, workspaceId: workspace.id })
  const sessionDir = join(data, '.copilot', 'session-state', session.agentSessionId)
  mkdirSync(sessionDir, { recursive: true })
  const events = join(sessionDir, 'events.jsonl')
  await page.locator('.card .character__art').first().waitFor()
  await page.waitForFunction(async (id) =>
    (await window.crew.getRoster()).find((s) => s.id === id)?.state === 'WORKING', session.id)
  const interactiveArtwork = await page.locator('.card .character__art').first().innerHTML()
  writeFileSync(events, mode('autopilot') + '\n')
  const waitForMode = async (on) => {
    await page.waitForFunction(async ({ id, on }) =>
      (await window.crew.getRoster()).find((s) => s.id === id)?.autopilot === on &&
      window.modeUpdates.at(-1)?.find((s) => s.id === id)?.autopilot === on,
    { id: session.id, on }, { timeout: 10_000 })
    await page.locator('.card .character--autopilot').first().waitFor({
      state: on ? 'visible' : 'detached', timeout: 10_000
    })
  }
  await waitForMode(true)
  assert.notEqual(await page.locator('.card .character__art').first().innerHTML(), interactiveArtwork)
  const browserWindow = await app.browserWindow(page)
  await browserWindow.evaluate((window) => window.webContents.send('evt:openWorkspaces'))
  await page.locator('.workspace-manager').waitFor()
  const workspaceCard = page.locator('.workspace-card').filter({ hasText: 'Autopilot regression fixture' }).first()
  await workspaceCard.locator('.character--autopilot').waitFor()
  assert.match(await workspaceCard.locator('.character').getAttribute('title'), /^autopilot · /)

  const secondReady = app.waitForEvent('window')
  await page.evaluate(() => window.crew.openWindow())
  const second = await secondReady
  second.on('pageerror', (error) => errors.push(String(error)))
  await second.locator('.card .character--autopilot').first().waitFor()

  appendFileSync(events, mode('interactive') + '\n')
  await waitForMode(false)
  await workspaceCard.locator('.character--autopilot').waitFor({ state: 'detached' })
  await second.locator('.card .character--autopilot').first().waitFor({ state: 'detached' })
  assert.equal(await page.locator('.card .character__art').first().innerHTML(), interactiveArtwork)
  const event = mode('autopilot')
  const split = event.indexOf('newMode')
  appendFileSync(events, event.slice(0, split))
  // Observe at least one main-process poll while the event is incomplete.
  await page.waitForTimeout(1300)
  assert.equal((await page.evaluate(() => window.crew.getRoster()))[0].autopilot, false)
  appendFileSync(events, event.slice(split) + '\n')
  await waitForMode(true)
  await workspaceCard.locator('.character--autopilot').waitFor()
  await second.locator('.card .character--autopilot').first().waitFor()
  await page.locator('.workspace-manager__close').click()

  await app.close()
  app = await launch()
  const restored = await app.firstWindow()
  restored.on('pageerror', (error) => errors.push(String(error)))
  await restored.waitForSelector('.app')
  await restored.evaluate((id) => window.crew.wake(id), session.id)
  await restored.locator('.card .character--autopilot').first().waitFor({ timeout: 10_000 })
  const [resumed] = await restored.evaluate(() => window.crew.getRoster())
  assert.equal(resumed.agentSessionId, session.agentSessionId)
  assert.equal(resumed.autopilot, true)
  await restored.evaluate((id) => window.crew.closeSession(id), session.id)
  assert.deepEqual(errors, [])
  console.log('PASS: pilot artwork, workspace cards, IPC, two-window on/off updates, split events, app restart; isolated fake PTY, no inference.')
} finally {
  if (app) await app.close()
  rmSync(data, { recursive: true, force: true })
}
