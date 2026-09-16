// Focused custom-view E2E for Task 6.
// Runs an isolated browser integration that exercises the real renderer flow:
// create a Release queue, rank sessions, reload to prove persistence, remove a
// ranked session, delete the active view, and assert zero renderer/main errors.

import { chromium } from 'playwright'
import { createServer, optimizeDeps, resolveConfig } from 'vite'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const ARTIFACTS = resolve(`.custom-view-e2e-${process.pid}`)
const FIXTURE = '/src/renderer/__tests__/custom-view-e2e-fixture.tsx'
const STUBBED_COMPONENTS = new Set([
  'SessionView',
  'NewSessionModal',
  'SettingsModal',
  'BroadcastModal',
  'TranscriptsModal',
  'ProjectTracker',
  'WorkspaceManager',
  'AgentInvoke',
  'AgentEditor',
  'AgentRunPanel',
  'CommandPalette',
  'UpdateBanner',
  'TitleSequence'
])

async function startHarness() {
  mkdirSync(ARTIFACTS, { recursive: true })
  const config = {
    configFile: false,
    root: ROOT,
    cacheDir: `${ARTIFACTS}/vite`,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: {
      noDiscovery: true,
      include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']
    },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'isolated-custom-view-e2e',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.endsWith('/src/renderer/App.tsx')) return null
        const name = source.split('/').at(-1)
        if (source.startsWith('./components/') && name && STUBBED_COMPONENTS.has(name)) {
          return '\0custom-view-e2e:' + name
        }
        return null
      },
      load(id) {
        if (!id.startsWith('\0custom-view-e2e:')) return null
        const name = id.split(':')[1]
        return `export function ${name}() { return null }`
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/custom-view-e2e') return next()
          res.setHeader('Content-Type', 'text/html')
          res.end(`<div id="root"></div><script type="module" src="${FIXTURE}"></script>`)
        })
      }
    }]
  }

  await optimizeDeps(await resolveConfig(config, 'serve'))
  const server = await createServer(config)
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('No custom-view E2E server address')

  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = ARTIFACTS
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  }

  return {
    server,
    browser,
    origin: `http://127.0.0.1:${address.port}`
  }
}

async function openPage(context, origin, rendererErrors) {
  const page = await context.newPage()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/Failed to load resource/i.test(text) && /404/.test(text)) return
    if (/\bmain\.tsx\b|\.map\b/i.test(text)) return
    if (/Content Security Policy/i.test(text)) return
    rendererErrors.push(text)
  })
  await page.goto(`${origin}/custom-view-e2e`)
  await page.waitForSelector('.app', { timeout: 5000 })
  return page
}

async function sessionOrder(page, selector) {
  return await page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => element.getAttribute('data-session-id'))
      .filter(Boolean)
  )
}

export async function runCustomViewE2E() {
  const harness = await startHarness()
  const rendererErrors = []
  const mainErrors = []
  const checks = []
  const context = await harness.browser.newContext()
  let page = null
  try {
    page = await openPage(context, harness.origin, rendererErrors)
    await page.evaluate(() => {
      localStorage.clear()
    })
    await page.reload()
    await page.waitForSelector('.app', { timeout: 5000 })

    const queueSessions = await page.evaluate(async () => {
      const labels = ['Queue Alpha', 'Queue Beta', 'Queue Gamma']
      const sessions = []
      for (const label of labels) {
        sessions.push(
          await window.crew.createSession({
            presetId: null,
            command: 'node',
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cwd: '/work/custom-views',
            label
          })
        )
      }
      return sessions.map((session) => ({ id: session.id, label: session.label }))
    })
    const [queueAlpha, queueBeta, queueGamma] = queueSessions

    await page.waitForFunction(async () => (await window.crew.getRoster()).length === 3)
    checks.push('created three sessions for the custom-view journey')

    await page.locator('.roster__toolbar [title="Choose session view"]').click()
    await page.getByRole('menuitem', { name: 'New custom view' }).click()
    await page.getByLabel('View name').fill('Release queue')
    await page.getByRole('searchbox', { name: 'Search all sessions' }).fill(queueAlpha.label)
    await page
      .locator(
        `.custom-view-organizer__available-card[data-session-id="${queueAlpha.id}"] [data-drag-handle]`
      )
      .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'))
    await page.getByRole('searchbox', { name: 'Search all sessions' }).fill(queueBeta.label)
    await page
      .locator(
        `.custom-view-organizer__available-card[data-session-id="${queueBeta.id}"] [data-drag-handle]`
      )
      .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'))

    const rankedBeforeSave = await sessionOrder(page, '.custom-view-organizer__ranked-card')
    if (JSON.stringify(rankedBeforeSave) !== JSON.stringify([queueBeta.id, queueAlpha.id])) {
      throw new Error(`ranked order before save was ${JSON.stringify(rankedBeforeSave)}`)
    }
    checks.push('dragging a second session to rank 1 moves the first to rank 2')

    await page.getByRole('button', { name: 'Save view' }).click()
    await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
    const expectedQueueOrder = [queueBeta.id, queueAlpha.id, queueGamma.id]
    await page.waitForFunction(
      async (expected) =>
        JSON.stringify(
          Array.from(document.querySelectorAll('.roster__list .card'))
            .map((element) => element.getAttribute('data-session-id'))
            .filter(Boolean)
        ) === JSON.stringify(expected),
      expectedQueueOrder
    )
    checks.push('saved custom view orders the roster')

    await page.locator('.view-toggle button[title="Grid view"]').click()
    await page.waitForSelector('.grid .tile', { timeout: 5000 })
    const rosterQueueOrder = await sessionOrder(page, '.roster__list .card')
    const gridQueueOrder = await sessionOrder(page, '.grid .tile')
    if (JSON.stringify(rosterQueueOrder) !== JSON.stringify(expectedQueueOrder)) {
      throw new Error(`roster order mismatch: ${JSON.stringify(rosterQueueOrder)}`)
    }
    if (JSON.stringify(gridQueueOrder) !== JSON.stringify(expectedQueueOrder)) {
      throw new Error(`grid order mismatch: ${JSON.stringify(gridQueueOrder)}`)
    }
    checks.push('roster and grid use the same custom-view order')

    await page.close()
    page = await openPage(context, harness.origin, rendererErrors)

    await page.waitForFunction(async () => (await window.crew.getRoster()).length === 3)
    const reopenedOrder = await sessionOrder(page, '.roster__list .card')
    if (JSON.stringify(reopenedOrder) !== JSON.stringify(expectedQueueOrder)) {
      throw new Error(`restored roster order mismatch: ${JSON.stringify(reopenedOrder)}`)
    }

    await page.locator('.roster__toolbar [title="Choose session view"]').click()
    const persistedView = page.getByRole('menuitemradio', { name: /Release queue/ })
    if ((await persistedView.getAttribute('aria-checked')) !== 'true') {
      throw new Error('Release queue was not selected after relaunch')
    }
    checks.push('custom-view selection and order persist across relaunch')

    await page.getByRole('button', { name: 'Edit view' }).click()
    await page
      .locator(
        `.custom-view-organizer__ranked-card[data-session-id="${queueAlpha.id}"] [data-drag-handle]`
      )
      .dragTo(page.locator('.custom-view-organizer__available-drop'))
    await page.getByRole('button', { name: 'Save view' }).click()
    await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
    const persistedItems = await page.evaluate(async () => {
      const view = (await window.crew.getCustomViews()).find((item) => item.name === 'Release queue')
      return view?.items.map((item) => item.sessionId) ?? []
    })
    if (JSON.stringify(persistedItems) !== JSON.stringify([queueBeta.id])) {
      throw new Error(`saved ranked items after removal were ${JSON.stringify(persistedItems)}`)
    }
    checks.push('dragging a ranked session back left removes it from the saved view')

    const removedOrder = [queueBeta.id, queueGamma.id, queueAlpha.id]
    await page.waitForFunction(
      async (expected) =>
        JSON.stringify(
          Array.from(document.querySelectorAll('.roster__list .card'))
            .map((element) => element.getAttribute('data-session-id'))
            .filter(Boolean)
        ) === JSON.stringify(expected),
      removedOrder
    )

    await page.locator('.roster__toolbar [title="Choose session view"]').click()
    await page.getByRole('button', { name: 'Edit view' }).click()
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: 'Delete view' }).click()
    await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 5000 })
    await page.locator('.roster__toolbar [title="Choose session view"]').click()
    const recentFallback = page.locator('[role="menuitemradio"]').filter({ hasText: 'By recent' })
    if ((await recentFallback.first().getAttribute('aria-checked')) !== 'true') {
      throw new Error('deleting the active custom view did not fall back to Recent')
    }
    if ((await page.locator('.group-menu__label', { hasText: 'Release queue' }).count()) !== 0) {
      throw new Error('Release queue still appeared after delete')
    }
    checks.push('deleting the active view falls back to Recent without deleting sessions')

    await page.evaluate(async (ids) => {
      for (const id of ids) await window.crew.closeSession(id)
    }, queueSessions.map((session) => session.id))
    await page.waitForFunction(async () => (await window.crew.getRoster()).length === 0)

    return { checks, rendererErrors, mainErrors }
  } finally {
    await page?.close().catch(() => {})
    await context.close()
    await harness.browser.close()
    await harness.server.close()
    rmSync(ARTIFACTS, { recursive: true, force: true })
  }
}

async function main() {
  const result = await runCustomViewE2E()
  for (const check of result.checks) console.log(`  ✓ ${check}`)
  console.log(`renderer errors: ${result.rendererErrors.length}`)
  console.log(`main-process errors: ${result.mainErrors.length}`)
  if (result.rendererErrors.length || result.mainErrors.length) {
    for (const error of result.rendererErrors) console.log(`  ✗ renderer error: ${error}`)
    for (const error of result.mainErrors) console.log(`  ✗ main-process error: ${error}`)
    process.exit(1)
  }
  console.log('\n✅ E2E PASSED')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('\n💥 E2E harness error:', error)
    process.exit(1)
  })
}
