import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer, optimizeDeps, resolveConfig, type InlineConfig, type ViteDevServer } from 'vite'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import './fixtures/renderer-regression-types'

let server: ViteDevServer
let browser: Browser
let origin: string
/**
 * Every test here drives a real browser against a Vite dev server. The first
 * page load compiles the renderer on demand, which on a cold CI runner takes
 * well over vitest's 5s default, and the whole file then fails on the clock
 * rather than on anything it asserts. Windows CI hit exactly that once the file
 * grew past ~25 tests.
 */
const BROWSER_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: BROWSER_TIMEOUT_MS, hookTimeout: 120_000 })

const artifacts = resolve(`.renderer-regressions-${process.pid}`)
const fixture = '/src/renderer/__tests__/renderer-regressions.tsx'
const skipBrowserTests = process.env.CREW_SKIP_BROWSER_TESTS === '1'

beforeAll(async () => {
  if (skipBrowserTests) return
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
        if (source === './terminal/facade') return '\0test-focus-terminal'
        if (
          source.startsWith('./components/') &&
          source !== './components/Character' &&
          source !== './components/CustomViewOrganizer'
        ) {
          return '\0test-view:' + source.split('/').at(-1) + '.tsx'
        }
      },
      load(id) {
        if (id === '\0test-focus-terminal') {
          return `export function focusTerminal(id) { globalThis.regression.focusedTerminals.push(id) }`
        }
        if (id.startsWith('\0test-view:')) {
          const name = id.split(':')[1].replace(/\.tsx$/, '')
          if (name === 'Roster' || name === 'GridView') {
            const prefix = name.toLowerCase()
            return `
              import React from 'react'
              export function ${name}(props) {
                const chooseFocus = () => props.onChoosePresentation({ kind: 'custom', viewId: 'focus' })
                const chooseSolo = () => props.onChoosePresentation({ kind: 'custom', viewId: 'solo' })
                const scrollProbe = ${name === 'GridView' ? `(node) => {
                  if (node) node.scrollTo = () => { globalThis.regression.gridScrolls++ }
                }` : 'undefined'}
                return React.createElement(
                  'div',
                  { className: 'stub-${prefix}', 'data-selected-id': props.selectedId ?? '' },
                  React.createElement(
                    'button',
                    { type: 'button', className: 'stub-${prefix}__choose', onClick: chooseFocus },
                    'choose'
                  ),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'stub-${prefix}__choose-solo', onClick: chooseSolo },
                    'choose-solo'
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'stub-${prefix}__new-view',
                      onClick: (event) => props.onCreateCustomView(event.currentTarget)
                    },
                    'new-view'
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'stub-${prefix}__edit-view',
                      onClick: (event) => props.onEditCustomView('focus', event.currentTarget)
                    },
                    'edit-view'
                  ),
                  ${name === 'Roster' ? `React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'stub-roster__single',
                      onClick: () => props.onSetViewMode('single')
                    },
                    'single'
                  ),` : ''}
                  ${name === 'GridView' ? `React.createElement(
                    'div',
                    { className: 'gridview__scroll', ref: scrollProbe }
                  ),` : ''}
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
          if (name === 'CommandPalette') {
            return `
              import React from 'react'
              export function CommandPalette(props) {
                globalThis.regression.paletteSessionItems = props.items
                  .filter((item) => item.id.startsWith('sess-'))
                  .map((item) => item.label)
                return React.createElement(
                  'div',
                  { className: 'stub-command-palette' },
                  ...props.items.map((item) =>
                    React.createElement('span', { key: item.id, 'data-item-id': item.id }, item.label)
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
  if (skipBrowserTests) return
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
      { timeout: BROWSER_TIMEOUT_MS, state: 'attached' }
    )
  } catch (error) {
    await page.close()
    throw new Error(errors.join('\n') || String(error))
  }
  return page
}

describe.skipIf(skipBrowserTests)('renderer state and input regressions (isolated browser)', () => {
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

  it('scrolls a session picked in the nav to the grid\u2019s left column', async () => {
    const page = await open('reveal')
    try {
      const offsetOf = (id: string) =>
        page.evaluate((sessionId) => {
          const sc = document.querySelector('.gridview__scroll')
          const tile = document.querySelector(`.tile[data-session-id="${sessionId}"]`)
          if (!sc || !tile) return null
          return Math.round(tile.getBoundingClientRect().left - sc.getBoundingClientRect().left)
        }, id)

      // b5 sits well off to the right of the two visible columns, but is not
      // the final column: the last column can never reach the left edge,
      // because there is nothing after it to scroll into view.
      const before = await offsetOf('b5')
      expect(before).not.toBeNull()
      expect(before as number).toBeGreaterThan(100)

      await page.click('.roster .card[data-session-id="b5"]', { timeout: 5000 })

      // Smooth scrolling settles asynchronously; poll rather than sleep.
      await page.waitForFunction(
        () => {
          const sc = document.querySelector('.gridview__scroll')
          const tile = document.querySelector('.tile[data-session-id="b5"]')
          if (!sc || !tile) return false
          return Math.abs(tile.getBoundingClientRect().left - sc.getBoundingClientRect().left) <= 2
        },
        { timeout: 8000 }
      )
      expect(Math.abs((await offsetOf('b5')) as number)).toBeLessThanOrEqual(2)
    } finally {
      await page.close()
    }
  }, 30000)

  it('leaves the grid where it is when a visible tile itself is clicked', async () => {
    const page = await open('reveal')
    try {
      await page.waitForSelector('.tile[data-session-id="a1"]', { timeout: 8000, state: 'attached' })
      const scrollLeft = () =>
        page.evaluate(() => {
          const sc = document.querySelector('.gridview__scroll')
          return sc ? Math.round(sc.scrollLeft) : null
        })
      // Clicking a tile records no navigation, so a fully visible tile must not
      // drag the layout out from under the cursor.
      const visible = await page.evaluate(() => {
        const sc = document.querySelector('.gridview__scroll')
        if (!sc) return null
        const box = sc.getBoundingClientRect()
        const tile = Array.from(document.querySelectorAll<HTMLElement>('.tile[data-session-id]')).find((t) => {
          const r = t.getBoundingClientRect()
          return r.width > 0 && r.left >= box.left - 1 && r.right <= box.right + 1
        })
        return tile?.getAttribute('data-session-id') ?? null
      })
      expect(visible).not.toBeNull()

      const before = await scrollLeft()
      await page.click(`.tile[data-session-id="${visible}"]`)
      await page.waitForTimeout(800)
      expect(await scrollLeft()).toBe(before)
    } finally {
      await page.close()
    }
  }, 30000)

  // The float opens on a dwell timer (300ms) and closes on a grace timer
  // (220ms); these waits must clear both.
  const FLOAT_OPEN_MS = 600
  const expanded = (page: Page) =>
    page.evaluate(() => document.querySelector('.roster')?.classList.contains('is-expanded') ?? null)

  it('floats the collapsed nav open when the cursor rests on the session list', async () => {
    const page = await open('nav-float')
    try {
      expect(await expanded(page)).toBe(false)
      await page.hover('.roster__list')
      await page.waitForTimeout(FLOAT_OPEN_MS)
      expect(await expanded(page)).toBe(true)
    } finally {
      await page.close()
    }
  }, 30000)

  it('keeps the collapsed nav shut while the cursor is on the view toggle', async () => {
    const page = await open('nav-float')
    try {
      await page.hover('.view-toggle')
      await page.waitForTimeout(FLOAT_OPEN_MS)
      expect(await expanded(page)).toBe(false)
    } finally {
      await page.close()
    }
  }, 30000)

  it('switches view from the toggle without the nav covering the result', async () => {
    const page = await open('nav-float')
    try {
      await page.click('.view-toggle__btn:last-child')
      await page.waitForTimeout(FLOAT_OPEN_MS)
      expect(await page.evaluate(() => globalThis.regression.modes)).toEqual(['grid'])
      expect(await expanded(page)).toBe(false)
    } finally {
      await page.close()
    }
  }, 30000)

  it('retracts an already-floated nav when the view toggle is used', async () => {
    const page = await open('nav-float')
    try {
      await page.hover('.roster__list')
      await page.waitForTimeout(FLOAT_OPEN_MS)
      expect(await expanded(page)).toBe(true)
      await page.click('.view-toggle__btn:last-child')
      await page.waitForTimeout(FLOAT_OPEN_MS)
      expect(await page.evaluate(() => globalThis.regression.modes)).toEqual(['grid'])
      expect(await expanded(page)).toBe(false)
    } finally {
      await page.close()
    }
  }, 30000)

  // A retired session is rebuilt from a snapshot and then keeps receiving the
  // agent's live output, which is drawn relative to the cursor. If the snapshot
  // does not restore the screen the agent thinks it is drawing on, that output
  // lands in the wrong place and rows composite on top of each other — the
  // duplicated/overlapping lines reported in session panes.
  it('leaves a rebuilt terminal identical to one that was never retired', async () => {
    const page = await open('snapshot-replay')
    try {
      await page.waitForSelector('.replay-done', { timeout: BROWSER_TIMEOUT_MS })
      const replay = await page.evaluate(() => globalThis.regression.replay)
      expect(replay).not.toBeNull()
      expect(replay!.control).toContain('done.')
      expect(replay!.rebuilt).toBe(replay!.control)
    } finally {
      await page.close()
    }
  }, 30000)

  // A full-screen TUI runs on the alternate buffer. Snapshotting the wrong
  // buffer — or dropping alt mode on rebuild — puts the agent's next repaint on
  // a different screen from the one it drew.
  it('restores a full-screen TUI on the alternate buffer across a rebuild', async () => {
    const page = await open('snapshot-replay')
    try {
      await page.waitForSelector('.replay-done', { timeout: BROWSER_TIMEOUT_MS })
      const alt = await page.evaluate(() => globalThis.regression.replayAlt)
      expect(alt).not.toBeNull()
      expect(alt!.controlAlt).toBe(true)
      expect(alt!.rebuiltAlt).toBe(alt!.controlAlt)
      expect(alt!.control).toContain('> two')
      expect(alt!.rebuilt).toBe(alt!.control)
    } finally {
      await page.close()
    }
  }, 30000)

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

  it.each(['Meta', 'Control'])(
    '%s custom curated views replace hidden selection and limit shortcuts and palette entries to presented sessions',
    async (modifier) => {
      const page = await open('app')
      try {
        await page.locator('.stub-roster__choose-solo').click()
        await page.waitForFunction(
          () =>
            document.querySelector('.stub-roster')?.getAttribute('data-selected-id') === 'a4' &&
            document.querySelector('.stub-gridview')?.getAttribute('data-selected-id') === 'a4'
        )
        expect(await page.evaluate(() => globalThis.regression.currentSelected)).toBe('a4')

        await page.keyboard.press(`${modifier}+1`)
        await page.keyboard.press(`${modifier}+2`)
        await page.keyboard.press(`${modifier}+j`)
        expect(await page.evaluate(() => globalThis.regression.selected.slice(-2))).toEqual(['a4', 'a4'])

        await page.keyboard.press(`${modifier}+k`)
        await page.waitForSelector('.stub-command-palette')
        expect(await page.evaluate(() => globalThis.regression.paletteSessionItems)).toEqual(['a4'])
        expect(await page.locator('[data-item-id="sess-a4"]').count()).toBe(1)
        expect(await page.locator('[data-item-id="sess-a1"]').count()).toBe(0)
      } finally {
        await page.close()
      }
    }
  )

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

  it('allows roster drag inside a custom view so its order can be edited, but not grid drag', async () => {
    const page = await open('components')
    try {
      // Dragging here reorders the *view's* items (via onReorderCustomView),
      // not the global roster order every other view shares.
      expect(await page.locator('.roster .card[draggable="true"]').count()).toBe(2)
      expect(await page.locator('.roster .card[draggable="false"]').count()).toBe(0)
      // The grid still has no per-view reorder path, so it stays disabled.
      expect(await page.locator('.gridview .tile__header[draggable="true"]').count()).toBe(0)
      expect(await page.locator('.gridview .tile__header[draggable="false"]').count()).toBe(2)
    } finally {
      await page.close()
    }
  })

  it('disables roster drag when the custom view groups by recency', async () => {
    const page = await open('components-grouped')
    try {
      // The buckets come from lastPromptAt, so a drop has nowhere to land and
      // would be silently discarded — better to refuse the drag outright.
      expect(await page.locator('.roster .card[draggable="true"]').count()).toBe(0)
      expect(await page.locator('.roster .card[draggable="false"]').count()).toBe(2)
    } finally {
      await page.close()
    }
  })

  it('keeps the ranked draft visible while search and filters narrow the full roster', async () => {
    const page = await open('organizer-edit')
    try {
      expect(await page.locator('.custom-view-organizer__available-card').allTextContents()).toEqual([
        expect.stringContaining('Alpha build'),
        expect.stringContaining('Beta review'),
        expect.stringContaining('Gamma docs'),
        expect.stringContaining('Delta test')
      ])
      expect(await page.locator('.custom-view-organizer__ranked-card').allTextContents()).toEqual([
        expect.stringContaining('Beta review'),
        expect.stringContaining('Recovered deploy'),
        expect.stringContaining('Gamma docs')
      ])
      expect(await page.locator('.custom-view-organizer__ranked-card').nth(1).textContent()).toContain(
        'Unavailable'
      )

      await page.getByRole('searchbox', { name: 'Search all sessions' }).fill('Alpha')
      expect(await page.locator('.custom-view-organizer__available-card').allTextContents()).toEqual([
        expect.stringContaining('Alpha build')
      ])
      expect(await page.locator('.custom-view-organizer__ranked-card').count()).toBe(3)

      await page.getByLabel('Workspace filter').selectOption('b')
      expect(await page.locator('.custom-view-organizer__available-card').count()).toBe(0)
      await page.getByRole('searchbox', { name: 'Search all sessions' }).fill('')
      expect(await page.locator('.custom-view-organizer__available-card').allTextContents()).toEqual([
        expect.stringContaining('Gamma docs'),
        expect.stringContaining('Delta test')
      ])
      await page.getByLabel('Status filter').selectOption('active')
      await page.getByLabel('Preset filter').selectOption('shell')
      expect(await page.locator('.custom-view-organizer__available-card').allTextContents()).toEqual([
        expect.stringContaining('Delta test')
      ])
      expect(await page.locator('.custom-view-organizer__ranked-card').count()).toBe(3)
    } finally {
      await page.close()
    }
  })

  it('traps keyboard focus, blocks app shortcuts, closes on Escape, and restores the grid opener', async () => {
    const page = await open('app')
    try {
      const gridOpener = page.locator('.stub-gridview__new-view')
      await gridOpener.focus()
      await page.keyboard.press('Enter')
      await page.waitForSelector('.custom-view-organizer', { timeout: 2000 })
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'View name',
        undefined,
        { timeout: 2000 }
      )
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('View name')

      await page.keyboard.press('Shift+Tab')
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Save view')
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('View name')

      await page.keyboard.press('Meta+n')
      expect(await page.evaluate(() => globalThis.regression.newDialogs)).toEqual([])
      await page.keyboard.press('Escape')
      await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 2000 })
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('stub-gridview__new-view'),
        undefined,
        { timeout: 2000 }
      )
    } finally {
      await page.close()
    }
  })

  it('restores focus to the actual edit opener in single view', async () => {
    const page = await open('app')
    try {
      await page.evaluate(() => globalThis.regression.view('single'))
      await page.waitForSelector('.stub-gridview', { state: 'detached', timeout: 2000 })
      await page.waitForFunction(
        () => globalThis.regression.focusedTerminals.includes('a1'),
        undefined,
        { timeout: 2000 }
      )
      await page.evaluate(() => {
        globalThis.regression.focusedTerminals = []
      })
      const singleOpener = page.locator('.stub-roster__edit-view')
      await singleOpener.focus()
      await page.keyboard.press('Space')
      await page.waitForSelector('.custom-view-organizer', { timeout: 2000 })
      await page.keyboard.press('Escape')
      await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 2000 })
      await page.waitForFunction(
        () => document.activeElement?.classList.contains('stub-roster__edit-view'),
        undefined,
        { timeout: 2000 }
      )
      await page.waitForTimeout(50)
      expect(await page.evaluate(() => globalThis.regression.focusedTerminals)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('selects the authoritative created view when another window creates one concurrently', async () => {
    const page = await open('app')
    try {
      await page.locator('.stub-gridview__new-view').click()
      await page.getByLabel('View name').fill('Fresh queue')
      await page.getByRole('button', { name: 'Save view' }).click()
      await page.waitForSelector('.custom-view-organizer', { state: 'detached', timeout: 2000 })
      expect(await page.evaluate(() => globalThis.regression.presentations.at(-1))).toBe(
        JSON.stringify({ kind: 'custom', viewId: 'created-view' })
      )
    } finally {
      await page.close()
    }
  })

  it('does not expose a foreground-notification toggle that can no longer change behavior', async () => {
    const page = await open('settings')
    try {
      expect(await page.getByText('Notifications', { exact: true }).count()).toBe(1)
      expect(await page.getByText('Only when unfocused', { exact: true }).count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('supports genuine keyboard activation and keeps pointer-only drag handles out of the tab order', async () => {
    const page = await open('organizer-new')
    try {
      expect(await page.locator('.custom-view-organizer__drag[role="button"]').count()).toBe(0)
      expect(
        await page.locator('.custom-view-organizer__drag').evaluateAll((handles) =>
          handles.every((handle) => (handle as HTMLElement).tabIndex === -1)
        )
      ).toBe(true)

      const add = page.getByRole('button', { name: 'Add Alpha build to ranked order' })
      await add.focus()
      await page.keyboard.press('Enter')
      expect(await page.locator('.custom-view-organizer__ranked-card').count()).toBe(1)
      const remove = page.getByRole('button', { name: 'Remove Alpha build from ranked order' })
      await remove.focus()
      await page.keyboard.press('Space')
      expect(await page.locator('.custom-view-organizer__ranked-card').count()).toBe(0)
    } finally {
      await page.close()
    }
  })

  it('uses large pointer targets with thin insertion rules and card-sized ordering controls', async () => {
    const page = await open('organizer-edit')
    try {
      const metrics = await page.locator('.custom-view-organizer').evaluate((root) => {
        const drop = root.querySelector<HTMLElement>('.custom-view-organizer__drop-line')!
        const order = root.querySelector<HTMLElement>('.custom-view-organizer__rank-actions button:not(:disabled)')!
        return {
          dropHeight: Number.parseFloat(getComputedStyle(drop).height),
          ruleHeight: Number.parseFloat(getComputedStyle(drop, '::before').height),
          orderHeight: Number.parseFloat(getComputedStyle(order).height),
          orderFont: Number.parseFloat(getComputedStyle(order).fontSize)
        }
      })
      expect(metrics.dropHeight).toBeGreaterThanOrEqual(14)
      expect(metrics.ruleHeight).toBeLessThanOrEqual(2)
      expect(metrics.orderHeight).toBeGreaterThanOrEqual(26)
      expect(metrics.orderFont).toBeGreaterThanOrEqual(9.5)
    } finally {
      await page.close()
    }
  })

  it('supports exact pointer insertion, right-column reorder, and drag-back removal', async () => {
    const page = await open('organizer-new')
    try {
      await page
        .locator('.custom-view-organizer__available-card[data-session-id="a1"] [draggable="true"]')
        .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'), { timeout: 1500 })
      await page
        .locator('.custom-view-organizer__available-card[data-session-id="a2"] [draggable="true"]')
        .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'), { timeout: 1500 })
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['a2', 'a1'])

      await page
        .locator('.custom-view-organizer__ranked-card[data-session-id="a1"] [draggable="true"]')
        .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="0"]'), { timeout: 1500 })
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['a1', 'a2'])

      await page
        .locator('.custom-view-organizer__ranked-card[data-session-id="a1"] [draggable="true"]')
        .dragTo(page.locator('.custom-view-organizer__available-drop'), { timeout: 1500 })
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['a2'])
    } finally {
      await page.close()
    }
  })

  it('adjusts downward insertion when an already-ranked session is dragged from the left roster', async () => {
    const page = await open('organizer-new')
    try {
      await page.getByRole('button', { name: 'Add Alpha build to ranked order' }).click()
      await page.getByRole('button', { name: 'Add Beta review to ranked order' }).click()
      await page.getByRole('button', { name: 'Add Gamma docs to ranked order' }).click()
      await page
        .locator('.custom-view-organizer__available-card[data-session-id="a1"] [data-drag-handle]')
        .dragTo(page.locator('.custom-view-organizer__drop-line[data-index="2"]'), { timeout: 1500 })
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['a2', 'a1', 'b1'])
    } finally {
      await page.close()
    }
  })

  it('provides keyboard equivalents for adding, removing, and ordering ranked sessions', async () => {
    const page = await open('organizer-new')
    try {
      await page.getByRole('button', { name: 'Add Alpha build to ranked order' }).click()
      await page.getByRole('button', { name: 'Add Beta review to ranked order' }).click()
      await page.getByRole('button', { name: 'Add Gamma docs to ranked order' }).click()
      await page.getByRole('button', { name: 'Move Gamma docs to first' }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Move Gamma docs down' }).focus()
      await page.keyboard.press('Space')
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['a1', 'b1', 'a2'])
      await page.getByRole('button', { name: 'Move Alpha build to last' }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Move Alpha build up' }).focus()
      await page.keyboard.press('Space')
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['b1', 'a1', 'a2'])
      await page.getByRole('button', { name: 'Remove Alpha build from ranked order' }).click()
      expect(
        await page.locator('.custom-view-organizer__ranked-card').evaluateAll((cards) =>
          cards.map((card) => card.getAttribute('data-session-id'))
        )
      ).toEqual(['b1', 'a2'])
    } finally {
      await page.close()
    }
  })

  it('disables Add for sessions that are already ranked', async () => {
    const page = await open('organizer-edit')
    try {
      expect(await page.getByRole('button', { name: 'Add Beta review to ranked order' }).isDisabled()).toBe(true)
      expect(await page.getByRole('button', { name: 'Add Gamma docs to ranked order' }).isDisabled()).toBe(true)
      expect(await page.getByRole('button', { name: 'Add Alpha build to ranked order' }).isDisabled()).toBe(false)
    } finally {
      await page.close()
    }
  })

  it('locks every payload-changing control and drag surface while Save is pending', async () => {
    const page = await open('organizer-edit')
    try {
      await page.evaluate(() => {
        globalThis.regression.holdCustomViewWrites = true
      })
      await page.getByRole('button', { name: 'Save view' }).click()
      await page.waitForFunction(
        () => document.querySelector('.custom-view-organizer')?.getAttribute('aria-busy') === 'true'
      )

      expect(await page.getByLabel('View name').isDisabled()).toBe(true)
      expect(await page.getByLabel('Display mode').isDisabled()).toBe(true)
      expect(await page.getByRole('searchbox', { name: 'Search all sessions' }).isDisabled()).toBe(true)
      expect(await page.getByLabel('Workspace filter').isDisabled()).toBe(true)
      expect(await page.getByLabel('Status filter').isDisabled()).toBe(true)
      expect(await page.getByLabel('Preset filter').isDisabled()).toBe(true)
      expect(await page.getByRole('button', { name: 'Add Alpha build to ranked order' }).isDisabled()).toBe(true)
      expect(await page.getByRole('button', { name: 'Remove Beta review from ranked order' }).isDisabled()).toBe(true)
      expect(await page.locator('.custom-view-organizer__drag[draggable="true"]').count()).toBe(0)

      await page.evaluate(() => globalThis.regression.releaseCustomViewWrite())
      await page.waitForSelector('.organizer-closed')
    } finally {
      await page.close()
    }
  })

  it('focuses the busy dialog fallback and disables background grid arrows and shortcuts during Save', async () => {
    const page = await open('app')
    try {
      await page.locator('.stub-gridview__new-view').focus()
      await page.keyboard.press('Enter')
      await page.waitForSelector('.custom-view-organizer')
      await page.getByLabel('View name').fill('Held save')
      await page.evaluate(() => {
        globalThis.regression.holdCustomViewWrites = true
        globalThis.regression.gridScrolls = 0
      })
      await page.getByRole('button', { name: 'Save view' }).click()
      await page.waitForFunction(
        () => document.querySelector('.custom-view-organizer')?.getAttribute('aria-busy') === 'true'
      )

      expect(await page.evaluate(() => document.activeElement?.classList.contains('custom-view-organizer'))).toBe(true)
      expect(await page.locator('.custom-view-organizer').getAttribute('tabindex')).toBe('-1')

      await page.locator('.stub-gridview__new-view').focus()
      expect(await page.evaluate(() => document.activeElement?.classList.contains('custom-view-organizer'))).toBe(true)

      const arrowPrevented = await page.locator('.custom-view-organizer').evaluate((dialog) => {
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true
        })
        dialog.dispatchEvent(event)
        return event.defaultPrevented
      })
      expect(arrowPrevented).toBe(false)
      expect(await page.evaluate(() => globalThis.regression.gridScrolls)).toBe(0)

      await page.keyboard.press('Meta+n')
      expect(await page.evaluate(() => globalThis.regression.newDialogs)).toEqual([])

      await page.evaluate(() => globalThis.regression.releaseCustomViewWrite())
      await page.waitForSelector('.custom-view-organizer', { state: 'detached' })
    } finally {
      await page.close()
    }
  })

  it('enters a non-resurrecting conflict state if an edited view disappears', async () => {
    const page = await open('organizer-edit')
    try {
      await page.evaluate(() => globalThis.regression.removeOrganizerView())
      const alert = page.getByRole('alert')
      expect(await alert.textContent()).toContain('deleted in another window')
      expect(await page.getByRole('button', { name: 'Save view' }).count()).toBe(0)
      expect(await page.getByRole('button', { name: 'Close' }).count()).toBe(1)
      await page.keyboard.press('Enter')
      expect(await page.evaluate(() => globalThis.regression.customViewCreates)).toEqual([])
      expect(await page.evaluate(() => globalThis.regression.customViewUpdates)).toEqual([])
    } finally {
      await page.close()
    }
  })

  it('saves one complete replacement, while Cancel performs no write', async () => {
    const editPage = await open('organizer-edit')
    try {
      await editPage.getByLabel('View name').fill('Ship queue')
      await editPage.getByLabel('Display mode').selectOption('curated-only')
      await editPage.getByRole('button', { name: 'Move Gamma docs to first' }).click()
      await editPage.getByRole('button', { name: 'Save view' }).click()
      await editPage.waitForSelector('.organizer-closed')
      expect(await editPage.evaluate(() => globalThis.regression.customViewCreates)).toEqual([])
      expect(await editPage.evaluate(() => globalThis.regression.customViewUpdates)).toEqual([
        {
          id: 'organizer-view',
          input: {
            name: 'Ship queue',
            mode: 'curated-only',
            groupBy: 'none',
            items: [
              { sessionId: 'b1', labelSnapshot: 'Gamma docs' },
              { sessionId: 'a2', labelSnapshot: 'Beta review' },
              { sessionId: 'missing-session', labelSnapshot: 'Recovered deploy' }
            ]
          }
        }
      ])
    } finally {
      await editPage.close()
    }

    const cancelPage = await open('organizer-new')
    try {
      await cancelPage.getByLabel('View name').fill('Discard me')
      await cancelPage.getByRole('button', { name: 'Add Alpha build to ranked order' }).click()
      await cancelPage.getByRole('button', { name: 'Cancel' }).click()
      await cancelPage.waitForSelector('.organizer-closed')
      expect(await cancelPage.evaluate(() => globalThis.regression.customViewCreates)).toEqual([])
      expect(await cancelPage.evaluate(() => globalThis.regression.customViewUpdates)).toEqual([])
      expect(await cancelPage.evaluate(() => globalThis.regression.customViewDeletes)).toEqual([])
    } finally {
      await cancelPage.close()
    }
  })

  it('creates once, confirms deletion, and leaves failed drafts open with an alert', async () => {
    const createPage = await open('organizer-new')
    try {
      await createPage.getByLabel('View name').fill('Fresh queue')
      await createPage.getByRole('button', { name: 'Add Delta test to ranked order' }).click()
      await createPage.getByRole('button', { name: 'Save view' }).click()
      await createPage.waitForSelector('.organizer-closed')
      expect(await createPage.evaluate(() => globalThis.regression.customViewCreates)).toEqual([
        {
          name: 'Fresh queue',
          mode: 'ranked-plus-all',
          groupBy: 'none',
          items: [{ sessionId: 'b2', labelSnapshot: 'Delta test' }]
        }
      ])
    } finally {
      await createPage.close()
    }

    const deletePage = await open('organizer-edit')
    try {
      deletePage.once('dialog', (dialog) => void dialog.dismiss())
      await deletePage.getByRole('button', { name: 'Delete view' }).click()
      expect(await deletePage.evaluate(() => globalThis.regression.customViewDeletes)).toEqual([])
      deletePage.once('dialog', (dialog) => void dialog.accept())
      await deletePage.getByRole('button', { name: 'Delete view' }).click()
      await deletePage.waitForSelector('.organizer-closed')
      expect(await deletePage.evaluate(() => globalThis.regression.customViewDeletes)).toEqual([
        'organizer-view'
      ])
    } finally {
      await deletePage.close()
    }

    const errorPage = await open('organizer-edit')
    try {
      await errorPage.evaluate(() => {
        globalThis.regression.failCustomViewWrites = true
      })
      await errorPage.getByRole('button', { name: 'Save view' }).click()
      expect(await errorPage.getByRole('alert').textContent()).toContain('Synthetic update failure')
      expect(await errorPage.getByLabel('View name').inputValue()).toBe('Release queue')
      expect(await errorPage.locator('.custom-view-organizer').count()).toBe(1)
    } finally {
      await errorPage.close()
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
