import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createServer, optimizeDeps, resolveConfig, type InlineConfig, type ViteDevServer } from 'vite'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import './fixtures/renderer-regression-types'

let server: ViteDevServer
let browser: Browser
let origin: string
const artifacts = resolve(`.renderer-regressions-${process.pid}`)
const fixture = '/src/renderer/__tests__/renderer-regressions.tsx'

beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true })
  const config: InlineConfig = {
    configFile: false,
    root: process.cwd(),
    cacheDir: `${artifacts}/vite`,
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-unicode11', '@xterm/addon-image'] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'isolated-renderer-regressions',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.endsWith('/src/renderer/App.tsx')) return
        if (source === './hooks') return resolve(`.${fixture}`)
        if (source.startsWith('./components/') && source !== './components/Character') {
          return '\0test-view:' + source.split('/').at(-1) + '.tsx'
        }
      },
      load(id) {
        if (id.startsWith('\0test-view:')) {
          const name = id.split(':')[1].replace(/\.tsx$/, '')
          if (name === 'Roster' || name === 'GridView') {
            const prefix = name.toLowerCase()
            return `
              import React from 'react'
              export function ${name}(props) {
                const chooseFocus = () => props.onChoosePresentation({ kind: 'custom', viewId: 'focus' })
                return React.createElement(
                  'div',
                  { className: 'stub-${prefix}' },
                  React.createElement(
                    'button',
                    { type: 'button', className: 'stub-${prefix}__choose', onClick: chooseFocus },
                    'choose'
                  ),
                  React.createElement(
                    'div',
                    { className: 'stub-${prefix}__order' },
                    ...props.roster.map((session) =>
                      React.createElement('span', { key: session.id, 'data-session-id': session.id }, session.id)
                    )
                  )
                )
              }
            `
          }
          return `export function ${name}() { return null }`
        }
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/regression?')) return next()
          res.setHeader('Content-Type', 'text/html')
          res.end(`<div id="root"></div><script type="module" src="${fixture}"></script>`)
        })
      }
    }]
  }
  // Finish cold dependency optimization before a test page can receive a reload.
  await optimizeDeps(await resolveConfig(config, 'serve'))
  server = await createServer(config)
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw new Error('No test server address')
  origin = `http://127.0.0.1:${address.port}`
  // Keep browser profiles/artifacts in the project, never system temp or Crew data.
  const previous = process.env.TMPDIR
  process.env.TMPDIR = artifacts
  try {
    browser = await chromium.launch({ headless: true })
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await server?.close()
  rmSync(artifacts, { recursive: true, force: true })
})

async function open(kind: string) {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/regression?fixture=${kind}`)
  try {
    await page.waitForSelector(
      kind === 'workspace'
        ? '.workspace-card'
        : kind === 'composer'
          ? '.transcript-composer'
          : kind === 'hook-fallback'
            ? '.hook-presentation'
            : '.app',
      { timeout: 5000, state: 'attached' }
    )
  } catch (error) {
    await page.close()
    throw new Error(errors.join('\n') || String(error))
  }
  return page
}

describe('renderer state and input regressions (isolated browser)', () => {
  it('forwards workspace-card autopilot false → true → false to the actual Character', async () => {
    const page = await open('workspace')
    try {
      const character = page.locator('.workspace-card__glyph .character')
      const base = await character.innerHTML()
      expect(await character.getAttribute('class')).not.toContain('character--autopilot')
      await page.evaluate(() => globalThis.regression.pilot(true))
      await page.waitForSelector('.workspace-card .character--autopilot', { timeout: 1500 })
      expect(await character.getAttribute('title')).toBe('autopilot · waiting for you')
      expect(await character.innerHTML()).not.toBe(base)
      expect(await character.locator('.character__pilot').count()).toBe(0)
      await page.evaluate(() => globalThis.regression.pilot(false))
      await page.waitForSelector('.workspace-card .character:not(.character--autopilot)')
      expect(await character.getAttribute('title')).toBeNull()
      expect(await character.innerHTML()).toBe(base)
    } finally {
      await page.close()
    }
  })

  it.each(['Meta', 'Control'])('%s shortcuts use the latest workspace without a roster or selection change', async (modifier) => {
    const page = await open('app')
    try {
      await page.keyboard.press(`${modifier}+1`)
      await page.evaluate(() => globalThis.regression.workspace('b'))
      await page.waitForFunction(() => globalThis.regression.activeWorkspace === 'b')
      await page.keyboard.press(`${modifier}+1`)
      await page.keyboard.press(`${modifier}+9`)
      await page.keyboard.press(`${modifier}+j`)
      expect(await page.evaluate(() => globalThis.regression.selected)).toEqual(['a1', 'b1', 'b9', 'b1'])
      expect(await page.evaluate(() => globalThis.regression.modes)).toEqual(['single', 'single', 'single', 'single'])
      await page.evaluate(() => globalThis.regression.workspace('empty'))
      await page.waitForFunction(() => globalThis.regression.activeWorkspace === 'empty')
      await page.keyboard.press(`${modifier}+1`)
      await page.keyboard.press(`${modifier}+j`)
      expect(await page.evaluate(() => globalThis.regression.selected.length)).toBe(4)
      await page.keyboard.press(`${modifier}+n`)
      await page.keyboard.press(`${modifier}+Shift+n`)
      expect(await page.evaluate(() => globalThis.regression.newDialogs)).toEqual([true])
      expect(await page.evaluate(() => globalThis.regression.windows)).toBe(1)
    } finally {
      await page.close()
    }
  })

  it('renders built-in and custom views in the picker and only exposes edit for the active custom view', async () => {
    const page = await open('picker')
    try {
      await page.locator('button[aria-haspopup="menu"]').click()
      const items = await page.locator('[role="menuitemradio"]').allTextContents()
      expect(items.slice(0, 4)).toEqual(['No grouping', 'Needs you', 'By group', 'By recent'])
      expect(items[4]).toContain('Release queue')
      expect(items[4]).toContain('Ranked + all')
      expect(items[4]).toContain('2 ranked')
      expect(items[5]).toContain('Today only')
      expect(items[5]).toContain('Curated only')
      expect(items[5]).toContain('1 ranked')
      expect(await page.locator('.group-menu').textContent()).toContain('Custom views')
      expect(await page.locator('button:has-text("New custom view")').count()).toBe(1)
      expect(await page.locator('button:has-text("Edit view")').count()).toBe(1)
      await page.locator('[role="menuitemradio"]:has-text("Today only")').click()
      expect(await page.evaluate(() => globalThis.regression.presentations.at(-1))).toBe(
        JSON.stringify({ kind: 'custom', viewId: 'solo' })
      )
    } finally {
      await page.close()
    }
  })

  it('composes roster and grid custom-view order after workspace filtering without global reorder', async () => {
    const page = await open('app')
    try {
      await page.locator('.stub-roster__choose').click()
      const rosterIds = await page.locator('.stub-roster__order [data-session-id]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-session-id'))
      )
      const gridIds = await page.locator('.stub-gridview__order [data-session-id]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-session-id'))
      )
      expect(rosterIds).toEqual(['a2', 'a9', 'a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a1'])
      expect(gridIds).toEqual(rosterIds)
      expect(await page.evaluate(() => globalThis.regression.reorders)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('falls back a missing custom presentation to built-in Recent', async () => {
    const page = await open('hook-fallback')
    try {
      await page.waitForFunction(
        () => document.querySelector('.hook-presentation')?.textContent === 'builtin:recent'
      )
      expect(await page.locator('.hook-presentation').textContent()).toBe('builtin:recent')
    } finally {
      await page.close()
    }
  })

  it('disables ordinary roster and grid drag while a custom view is active', async () => {
    const page = await open('components')
    try {
      expect(await page.locator('.roster .card[draggable="true"]').count()).toBe(0)
      expect(await page.locator('.gridview .tile__header[draggable="true"]').count()).toBe(0)
      expect(await page.locator('.roster .card[draggable="false"]').count()).toBe(2)
      expect(await page.locator('.gridview .tile__header[draggable="false"]').count()).toBe(2)
    } finally {
      await page.close()
    }
  })

  it.each(['Enter', 'button'])('records composer %s submissions once and attributes tool results', async (submit) => {
    const page = await open('composer')
    try {
      const input = page.locator('.transcript-composer__input')
      await input.fill('printf hello\nprintf world  \n')
      if (submit === 'Enter') await input.press('Enter')
      else await page.locator('.transcript-composer__send').click()
      expect(await input.inputValue()).toBe('')
      expect(await page.evaluate(() => globalThis.regression.sent)).toEqual([
        { id: 'composer', data: 'printf hello\nprintf world\r' }
      ])
      expect(await page.evaluate(() => globalThis.regression.transcript())).toEqual([
        expect.objectContaining({ kind: 'user', text: 'printf hello\nprintf world' })
      ])
      expect(await page.evaluate(() => globalThis.regression.pending())).toBe(0)
      await page.evaluate(() => globalThis.regression.complete())
      expect(await page.evaluate(() => globalThis.regression.transcript())).toEqual([
        expect.objectContaining({ kind: 'user', text: 'printf hello\nprintf world' }),
        expect.objectContaining({ kind: 'tool', command: 'printf hello\nprintf world', exitCode: 0 })
      ])
    } finally {
      await page.close()
    }
  })

  it('does not submit whitespace or Shift+Enter and respects legacy facade routing', async () => {
    const page = await open('composer')
    try {
      const input = page.locator('.transcript-composer__input')
      await input.fill('   ')
      await input.press('Enter')
      await input.fill('draft')
      await input.press('Shift+Enter')
      expect(await page.evaluate(() => globalThis.regression.sent)).toEqual([])
      expect(await page.evaluate(() => globalThis.regression.transcript())).toEqual([])
      await page.evaluate(() => globalThis.regression.legacy())
      await input.fill('legacy command')
      await input.press('Enter')
      expect(await page.evaluate(() => globalThis.regression.sent)).toEqual([
        { id: 'composer', data: 'legacy command\r' }
      ])
      expect(await page.evaluate(() => globalThis.regression.transcript())).toEqual([])
    } finally {
      await page.close()
    }
  })
})
