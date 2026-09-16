// Signed-app Custom Views relaunch verification.
// Requires CREW_SIGNED_APP_PATH to point at a Developer ID signed Crew.app (or
// its Contents/MacOS/Crew executable). Reuses one test user-data dir across
// relaunch, exercises the full create/rank/save/select/edit/remove/delete flow,
// and reports renderer page errors plus actual process stderr/main errors.

import { _electron as electron } from 'playwright'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attachRendererErrorCapture,
  runCustomViewsRelaunchScenario
} from './custom-views-scenario.mjs'

const ROOT = resolve(process.cwd())
const DATA_DIR = `/tmp/crew-custom-views-signed-${process.pid}`
const MAIN_ERROR_RE = /\b(error|exception|throw)\b/i

export function extractMainErrors(lines) {
  return lines.filter((line) => MAIN_ERROR_RE.test(line))
}

function resolveSignedAppExecutable(inputPath) {
  const resolved = resolve(inputPath)
  if (resolved.endsWith('.app')) return join(resolved, 'Contents/MacOS/Crew')
  return resolved
}

function recordProcessOutput(app, stderrLines, mainErrors) {
  const record = (target, classifyErrors) => (chunk) => {
    const lines = chunk
      .toString()
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
    target.push(...lines)
    if (classifyErrors) mainErrors.push(...extractMainErrors(lines))
  }

  const proc = app.process()
  proc.stderr?.on('data', record(stderrLines, true))
  proc.stdout?.on('data', record([], false))
}

async function launchSignedApp(executablePath, stderrLines, mainErrors) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${DATA_DIR}`],
    cwd: ROOT,
    env
  })
  recordProcessOutput(app, stderrLines, mainErrors)
  return app
}

async function openAppPage(app, rendererErrors) {
  const page = await app.firstWindow()
  attachRendererErrorCapture(page, rendererErrors)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.app', { timeout: 15000 })
  return page
}

async function main() {
  const configuredPath = process.env.CREW_SIGNED_APP_PATH
  if (!configuredPath) {
    console.log(
      'BLOCKED: set CREW_SIGNED_APP_PATH to a Developer ID signed Crew.app bundle or its Contents/MacOS/Crew executable before launching this scenario. No app was launched.'
    )
    process.exit(0)
  }

  const executablePath = resolveSignedAppExecutable(configuredPath)
  if (!existsSync(executablePath)) {
    console.error(`Missing signed Crew executable: ${executablePath}`)
    process.exit(1)
  }

  rmSync(DATA_DIR, { recursive: true, force: true })

  const rendererErrors = []
  const stderrLines = []
  const mainErrors = []
  let app = null
  let page = null

  try {
    app = await launchSignedApp(executablePath, stderrLines, mainErrors)
    page = await openAppPage(app, rendererErrors)

    const result = await runCustomViewsRelaunchScenario({
      page,
      relaunchPage: async (currentPage) => {
        await currentPage.close().catch(() => {})
        await app.close()
        app = await launchSignedApp(executablePath, stderrLines, mainErrors)
        return openAppPage(app, rendererErrors)
      }
    })

    for (const check of result.checks) console.log(`  ✓ ${check}`)
    console.log(`renderer errors: ${rendererErrors.length}`)
    console.log(`process stderr lines: ${stderrLines.length}`)
    console.log(`main-process errors: ${mainErrors.length}`)

    if (rendererErrors.length || mainErrors.length) {
      for (const error of rendererErrors) console.log(`  ✗ renderer error: ${error}`)
      for (const line of stderrLines) console.log(`  ✗ stderr: ${line}`)
      for (const error of mainErrors) console.log(`  ✗ main-process error: ${error}`)
      process.exitCode = 1
      return
    }

    console.log('\n✅ SIGNED-APP CUSTOM VIEWS RELAUNCH PASSED')
  } finally {
    await page?.close().catch(() => {})
    await app?.close().catch(() => {})
    rmSync(DATA_DIR, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  !process.env.VITEST &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error('\n💥 signed-app custom-view verification error:', error)
    process.exit(1)
  })
}
