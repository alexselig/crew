// Additive Custom Views renderer integration.
// Runs the real renderer in headless Chromium against a typed fake Crew API:
// create a Release queue, rank sessions, reload to prove persistence, remove a
// ranked session, delete the active view, and assert zero renderer errors.

import { chromium } from 'playwright'
import { createServer, optimizeDeps, resolveConfig } from 'vite'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  attachRendererErrorCapture,
  runCustomViewsRelaunchScenario
} from './custom-views-scenario.mjs'

const ROOT = resolve(process.cwd())
const ARTIFACTS = resolve(`.custom-view-renderer-integration-${process.pid}`)
const FIXTURE = '/src/renderer/__tests__/custom-view-renderer-integration-fixture.tsx'
const PATHNAME = '/custom-view-renderer-integration'
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
      name: 'custom-view-renderer-integration',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.endsWith('/src/renderer/App.tsx')) return null
        const name = source.split('/').at(-1)
        if (source.startsWith('./components/') && name && STUBBED_COMPONENTS.has(name)) {
          return '\0custom-view-renderer-integration:' + name
        }
        return null
      },
      load(id) {
        if (!id.startsWith('\0custom-view-renderer-integration:')) return null
        const name = id.split(':')[1]
        return `export function ${name}() { return null }`
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== PATHNAME) return next()
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
  if (!address || typeof address === 'string') {
    throw new Error('No custom-view renderer integration server address')
  }

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
    browser,
    origin: `http://127.0.0.1:${address.port}`,
    server
  }
}

async function openPage(context, origin, rendererErrors) {
  const page = await context.newPage()
  attachRendererErrorCapture(page, rendererErrors)
  await page.goto(`${origin}${PATHNAME}`)
  await page.waitForSelector('.app', { timeout: 5000 })
  return page
}

export async function runCustomViewRendererIntegration() {
  const harness = await startHarness()
  const rendererErrors = []
  const context = await harness.browser.newContext()
  let page = null
  try {
    page = await openPage(context, harness.origin, rendererErrors)
    const result = await runCustomViewsRelaunchScenario({
      page,
      preparePage: async (currentPage) => {
        await currentPage.evaluate(() => {
          localStorage.clear()
        })
        await currentPage.reload()
        await currentPage.waitForSelector('.app', { timeout: 5000 })
        return currentPage
      },
      relaunchPage: async (currentPage) => {
        await currentPage.close()
        return openPage(context, harness.origin, rendererErrors)
      }
    })
    return { checks: result.checks, rendererErrors }
  } finally {
    await page?.close().catch(() => {})
    await context.close()
    await harness.browser.close()
    await harness.server.close()
    rmSync(ARTIFACTS, { recursive: true, force: true })
  }
}

async function main() {
  const result = await runCustomViewRendererIntegration()
  for (const check of result.checks) console.log(`  ✓ ${check}`)
  console.log(`renderer errors: ${result.rendererErrors.length}`)
  if (result.rendererErrors.length) {
    for (const error of result.rendererErrors) console.log(`  ✗ renderer error: ${error}`)
    process.exit(1)
  }
  console.log('\n✅ CUSTOM VIEW RENDERER INTEGRATION PASSED')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('\n💥 custom-view renderer integration error:', error)
    process.exit(1)
  })
}
