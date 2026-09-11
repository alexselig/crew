// Isolated Electron 31 navigation regression; no Crew data, UI, providers, or build.
// Run: node test/e2e/preview-boundaries.e2e.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const work = resolve('test', `.preview-boundaries-${process.pid}`)
mkdirSync(work)
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'preview-boundaries-harness.ts',
      contents: `
        import { app, BrowserWindow, session } from 'electron'
        import { createServer } from 'node:http'
        import { strict as assert } from 'node:assert'
        import { installPreviewBoundary } from './src/main/main-boundaries'

        app.setPath('userData', ${JSON.stringify(join(work, 'profile'))})
        app.commandLine.appendSwitch('no-proxy-server')
        app.commandLine.appendSwitch('host-resolver-rules', 'MAP crew-preview-external.test 127.0.0.1')
        let externalHits = 0
        let checks = 0
        let host
        const server = createServer((req, res) => {
          if (req.headers.host?.startsWith('crew-preview-external.test')) externalHits++
          if (req.url === '/redirect-external') {
            res.writeHead(302, { location: external + '/forbidden' }).end()
          } else if (req.url === '/redirect-local') {
            res.writeHead(302, { location: local + '/next' }).end()
          } else {
            res.setHeader('content-type', 'text/html')
            res.end('<!doctype html><title>Local preview</title><body>Local</body>')
          }
        })
        let local
        let external
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        async function until(fn, label) {
          for (let n = 0; n < 100; n++) {
            if (await fn()) return
            await wait(30)
          }
          throw new Error('Timed out: ' + label)
        }
        const check = (condition, label) => { assert.ok(condition, label); checks++ }
        async function attach(src) {
          const attached = new Promise((resolve) => host.webContents.once('did-attach-webview', (_e, guest) => resolve(guest)))
          await host.webContents.executeJavaScript(
            'document.body.innerHTML = ""; var view = document.createElement("webview"); view.src = ' +
            JSON.stringify(src) + '; document.body.appendChild(view);'
          )
          const guest = await attached
          await until(() => guest.getURL() === src && !guest.isLoading(), 'guest load')
          return guest
        }
        async function run() {
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
          const port = server.address().port
          local = 'http://127.0.0.1:' + port
          external = 'http://crew-preview-external.test:' + port
          await app.whenReady()
          host = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } })
          installPreviewBoundary(host.webContents, () => {})
          await host.loadURL('data:text/html,<body></body>')
          let attachedCount = 0
          host.webContents.on('did-attach-webview', () => attachedCount++)
          await host.webContents.executeJavaScript(
            'var bad = document.createElement("webview"); bad.src = ' + JSON.stringify(external) +
            '; document.body.appendChild(bad);'
          )
          await wait(250)
          check(attachedCount === 0, 'external initial webview must not attach')

          const guest = await attach(local + '/')
          const externalCommits = []
          guest.on('did-frame-navigate', (_event, url) => {
            if (url.startsWith(external)) externalCommits.push(url)
          })
          check(guest.getURL() === local + '/', 'loopback initial document allowed')

          await guest.executeJavaScript('location.href = ' + JSON.stringify(external + '/top'))
          await wait(200)
          check(guest.getURL() === local + '/', 'external top navigation blocked')

          await guest.executeJavaScript('var frame = document.createElement("iframe"); frame.src = ' +
            JSON.stringify(external + '/frame') + '; document.body.appendChild(frame)')
          await wait(200)
          check(externalCommits.length === 0, 'external frame navigation blocked')

          await guest.executeJavaScript('location.href = ' + JSON.stringify(local + '/redirect-external'))
          await wait(200)
          check(!guest.getURL().startsWith(external), 'external top redirect blocked')

          await guest.loadURL(local + '/')
          await guest.executeJavaScript('var frame = document.createElement("iframe"); frame.src = ' +
            JSON.stringify(local + '/redirect-external') + '; document.body.appendChild(frame)')
          await wait(200)
          check(externalCommits.length === 0, 'external frame redirect blocked')

          await guest.loadURL(external + '/programmatic').catch(() => {})
          await wait(100)
          check(!guest.getURL().startsWith(external), 'programmatic external loadURL blocked')

          await host.webContents.executeJavaScript('document.querySelector("webview").src = ' +
            JSON.stringify(external + '/changed-src'))
          await wait(200)
          check(!guest.getURL().startsWith(external), 'changing webview src cannot bypass the document boundary')

          await guest.loadURL(local + '/redirect-local')
          await until(() => guest.getURL() === local + '/next' && !guest.isLoading(), 'local redirect')
          check(guest.getURL() === local + '/next', 'local redirect preserved')
          check(externalHits === 0, 'blocked documents never reach fake external origin')
          console.log('PASS: ' + checks + ' isolated Electron preview checks')
        }
        run().then(() => app.exit(0), (error) => { console.error(error); app.exit(1) })
      `
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: join(work, 'main.cjs'),
    logLevel: 'silent'
  })
  const env = { ...process.env, TMPDIR: work }
  delete env.ELECTRON_RUN_AS_NODE
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electronPath, [join(work, 'main.cjs')], { env, stdio: 'inherit' })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Isolated Electron regression timed out'))
    }, 30_000)
    child.on('error', reject)
    child.on('exit', (code) => { clearTimeout(timer); resolveExit(code ?? 1) })
  })
  if (exitCode !== 0) process.exitCode = exitCode
} finally {
  rmSync(work, { recursive: true, force: true })
}
