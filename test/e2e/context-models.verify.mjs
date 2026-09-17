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

  // Intercept only this isolated app's IPC; no real PTYs or inference are launched.
  await app.evaluate(({ ipcMain }) => {
    globalThis.modelFixture = 'pending'
    globalThis.modelCalls = []
    globalThis.createdRequests = []
    ipcMain.removeHandler('copilot:models')
    ipcMain.handle('copilot:models', () => {
      globalThis.modelCalls.push(globalThis.modelFixture)
      if (globalThis.modelFixture === 'pending') return new Promise(() => {})
      if (globalThis.modelFixture === 'failure') return { models: [], source: 'cli', error: 'Discovery unavailable' }
      if (globalThis.modelFixture === 'empty') return { models: [], source: 'cli' }
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
    await page.locator('.modal--session').waitFor()
  }
  const waitForModelRequest = async (fixture) => {
    await app.evaluate(async ({}, expected) => {
      while (!globalThis.modelCalls.includes(expected)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }, fixture)
    if (fixture !== 'pending') {
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      ))
    }
  }

  await open()
  await waitForModelRequest('pending')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).count(), 0)
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.locator('.modal--session').waitFor({ state: 'detached' })
  let request = await app.evaluate(() => globalThis.createdRequests.at(-1))
  assert.deepEqual(request.args, [])

  await app.evaluate(() => { globalThis.modelFixture = 'failure' })
  await open()
  await waitForModelRequest('failure')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).count(), 0)
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.locator('.modal--session').waitFor({ state: 'detached' })
  request = await app.evaluate(() => globalThis.createdRequests.at(-1))
  assert.deepEqual(request.args, [])

  await app.evaluate(() => { globalThis.modelFixture = 'empty' })
  await open()
  await waitForModelRequest('empty')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).count(), 0)
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.locator('.modal--session').waitFor({ state: 'detached' })
  request = await app.evaluate(() => globalThis.createdRequests.at(-1))
  assert.deepEqual(request.args, [])

  await app.evaluate(() => { globalThis.modelFixture = 'success' })
  await open()
  await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor()
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('gpt-5.5')
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.locator('.modal--session').waitFor({ state: 'detached' })
  request = await app.evaluate(() => globalThis.createdRequests.at(-1))
  assert.deepEqual(request.args, ['--model', 'gpt-5.5'])

  await app.evaluate(() => { globalThis.modelFixture = 'no-astra' })
  await open()
  await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor()
  await page.getByText('Astra is not listed by this CLI. Choose another model or update Copilot CLI.', { exact: true }).waitFor()
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isDisabled())
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('auto')
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('shell')
  assert.equal(await page.getByRole('combobox', { name: 'Model', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await app.evaluate(() => { globalThis.modelFixture = 'create-failure' })
  await open()
  await page.getByRole('combobox', { name: 'Model', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Fixture create rejected' }).waitFor()
  assert(await page.locator('.modal--session').isVisible())
  assert(await page.getByRole('button', { name: 'Launch', exact: true }).isEnabled())
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.deepEqual(errors, [])
  console.log('PASS: native-default pending/failed/empty catalogs, explicit selection, missing model, shell, and creation errors; no inference.')
} finally {
  if (app) await app.close()
  rmSync(data, { recursive: true, force: true })
}
