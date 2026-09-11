import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const data = mkdtempSync(join(tmpdir(), 'crew-context-models-'))
let app

try {
  app = await electron.launch({
    args: [join(root, 'out/main/index.js'), `--user-data-dir=${data}`],
    cwd: root
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.waitForSelector('.app')
  await page.locator('.roster__header button:has-text("New Session")').click()
  await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor({ timeout: 10_000 })

  // Real installed CLI discovery, without starting an agent or submitting a prompt.
  const live = await page.evaluate(() => window.crew.listCopilotModels())
  assert.equal(live.error, undefined, live.error)
  assert(live.models.includes('gpt-6-astra'), 'installed CLI advertises Astra')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'gpt-6-astra')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).locator('option').count(), live.models.length)
  assert(await page.getByLabel('Working directory', { exact: true }).isVisible())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  // Intercept only this isolated app's IPC; no real PTYs or inference are launched.
  await app.evaluate(({ ipcMain }) => {
    globalThis.modelFixture = 'success'
    globalThis.createdRequests = []
    ipcMain.removeHandler('copilot:models')
    ipcMain.handle('copilot:models', () => {
      if (globalThis.modelFixture === 'failure') return { models: [], source: 'cli', error: 'Discovery unavailable' }
      if (globalThis.modelFixture === 'no-astra') return { models: ['auto', 'gpt-5.5'], source: 'cli' }
      return { models: ['auto', 'gpt-6-astra', 'gpt-5.5'], source: 'cli' }
    })
    ipcMain.removeHandler('session:create')
    ipcMain.handle('session:create', (_event, request) => {
      if (globalThis.modelFixture === 'create-failure') throw new Error('Fixture create rejected')
      globalThis.createdRequests.push(request)
      return { id: 'fixture-created' }
    })
  })

  const open = async () => {
    await page.locator('.roster__header button:has-text("New Session")').click()
    await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor()
  }
  await open()
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-5.5')
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.locator('.modal--session').waitFor({ state: 'detached' })
  const [request] = await app.evaluate(() => globalThis.createdRequests)
  assert.deepEqual(request.args, ['--model', 'gpt-5.5'])

  await app.evaluate(() => { globalThis.modelFixture = 'failure' })
  await open()
  await page.getByRole('alert').filter({ hasText: 'Discovery unavailable' }).waitFor()
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isDisabled())
  await app.evaluate(() => { globalThis.modelFixture = 'success' })
  await page.getByRole('button', { name: 'Retry models', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('select[aria-label="Model"]')?.disabled)
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).inputValue(), 'gpt-6-astra')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await app.evaluate(() => { globalThis.modelFixture = 'no-astra' })
  await open()
  await page.getByText('Astra is not listed by this CLI. Choose another model or update Copilot CLI.', { exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isDisabled())
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('auto')
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('shell')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await app.evaluate(() => { globalThis.modelFixture = 'create-failure' })
  await open()
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Fixture create rejected' }).waitFor()
  assert(await page.locator('.modal--session').isVisible())
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log(`PASS: ${live.models.length} CLI models; Astra default, selection, retry, missing model, shell, creation errors; no inference.`)
} finally {
  if (app) await app.close()
  rmSync(data, { recursive: true, force: true })
}
