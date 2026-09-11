import { EventEmitter } from 'node:events'
import type { WebContents, WebPreferences } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedErrorReporter, createShellActions, installPreviewBoundary } from '../src/main/main-boundaries'

afterEach(() => vi.useRealTimers())

function preview() {
  const host = new EventEmitter()
  const guest = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    session: { webRequest: { onBeforeRequest: vi.fn() } }
  })
  const external = vi.fn()
  installPreviewBoundary(host as unknown as WebContents, external)
  host.emit('did-attach-webview', {}, guest)
  return { host, guest, external }
}

describe('local preview boundary', () => {
  it.each(['https://example.com', 'http://localhost.evil.test', 'http://localhost@evil.test', 'file:///secret', 'data:text/html,hello', 'about:blank'])(
    'refuses initial attachment to %s', (src) => {
      const { host } = preview()
      const event = { preventDefault: vi.fn() }
      host.emit('will-attach-webview', event, {}, { src })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  )

  it.each(['http://localhost:5173/', 'http://127.0.0.1:3000/', 'http://[::1]:8080/', 'https://localhost/', 'http://0.0.0.0:5173/'])(
    'preserves existing dev URL %s and isolates its preferences', (src) => {
      const { host } = preview()
      const event = { preventDefault: vi.fn() }
      const prefs: WebPreferences = { preload: '/untrusted', nodeIntegration: true }
      const params = { src, partition: 'persist:other' }
      host.emit('will-attach-webview', event, prefs, params)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(prefs.preload).toBeUndefined()
      expect(prefs.nodeIntegration).toBe(false)
      expect(prefs.contextIsolation).toBe(true)
      expect(prefs.partition).toBe('persist:crewapp')
      expect(params.partition).toBe('persist:crewapp')
    }
  )

  it.each(['will-navigate', 'will-frame-navigate', 'will-redirect'])(
    'blocks external %s, permits loopback, and does not auto-open the browser', (name) => {
      const { guest, external } = preview()
      for (const url of ['https://example.com/', 'http://localhost.evil.test/', 'file:///secret']) {
        const event = { url, preventDefault: vi.fn() }
        guest.emit(name, event, url)
        expect(event.preventDefault).toHaveBeenCalledOnce()
      }
      const event = { url: 'http://localhost:5173/next', preventDefault: vi.fn() }
      guest.emit(name, event, event.url)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(external).not.toHaveBeenCalled()
    }
  )

  it('guards programmatic document loads at request time without blocking remote subresources', () => {
    const { guest } = preview()
    const guard = guest.session.webRequest.onBeforeRequest.mock.calls[0][1]
    for (const resourceType of ['mainFrame', 'subFrame']) {
      const callback = vi.fn()
      guard({ url: 'https://example.com', resourceType }, callback)
      expect(callback).toHaveBeenCalledWith({ cancel: true })
    }
    const callback = vi.fn()
    guard({ url: 'https://example.com/script.js', resourceType: 'script' }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: false })
  })

  it('denies popups but deliberately hands valid HTTP links to the external opener', () => {
    const { guest, external } = preview()
    const handler = guest.setWindowOpenHandler.mock.calls[0][0]
    expect(handler({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(external).toHaveBeenCalledWith('https://example.com')
    handler({ url: 'javascript:alert(1)' })
    expect(external).toHaveBeenCalledTimes(1)
  })
})

function actions() {
  const native = {
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn()
  }
  const report = vi.fn()
  const exists = vi.fn()
  const api = createShellActions(native, (path) => path === '/known.png', report, exists)
  return { native, report, exists, api }
}

describe('visible shell failures with void-compatible APIs', () => {
  it('reports openPath error strings without rejecting', async () => {
    const { api, native, report } = actions()
    native.openPath.mockResolvedValue('No application is associated with this file')
    await expect(api.openAsset('/known.png')).resolves.toBeUndefined()
    expect(report.mock.calls[0][1]).toContain('No application is associated')
  })

  it('catches asynchronous and synchronous browser failures', async () => {
    const { api, native, report } = actions()
    native.openExternal.mockRejectedValueOnce(new Error('browser missing'))
    await expect(api.openExternal('https://example.com')).resolves.toBeUndefined()
    native.openExternal.mockImplementationOnce(() => { throw new Error('OS unavailable') })
    await expect(api.openExternal('https://example.com')).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it.each(['openAsset', 'revealAsset'] as const)('visibly rejects unindexed, malformed, and missing paths for %s', async (action) => {
    const { api, native, report, exists } = actions()
    await api[action]('/unknown.png')
    await api[action](null)
    exists.mockImplementation(() => { throw new Error('ENOENT') })
    await api[action]('/known.png')
    expect(report).toHaveBeenCalledTimes(3)
    expect(native.openPath).not.toHaveBeenCalled()
    expect(native.showItemInFolder).not.toHaveBeenCalled()
  })

  it('accepts successful opens and reveal calls without claiming OS reveal success', async () => {
    const { api, native, report } = actions()
    await api.openAsset('/known.png')
    await api.revealAsset('/known.png')
    expect(native.openPath).toHaveBeenCalledWith('/known.png')
    expect(native.showItemInFolder).toHaveBeenCalledWith('/known.png')
    expect(report).not.toHaveBeenCalled()
  })

  it('catches detectable reveal exceptions and rejects invalid external URLs visibly', async () => {
    const { api, native, report } = actions()
    native.showItemInFolder.mockImplementation(() => { throw new Error('invalid OS argument') })
    await api.revealAsset('/known.png')
    await api.openExternal('file:///secret')
    await api.openExternal(null)
    expect(report).toHaveBeenCalledTimes(3)
    expect(native.openExternal).not.toHaveBeenCalled()
  })
})

describe('bounded native error reporter', () => {
  it('queues startup warnings, batches them after ready, and deduplicates repeats', async () => {
    vi.useFakeTimers()
    const show = vi.fn().mockResolvedValue(undefined)
    const reporter = new BoundedErrorReporter(show, vi.fn())
    reporter.report('storage', 'Could not save')
    reporter.report('recovery', 'Recovered snapshot')
    await vi.runAllTimersAsync()
    expect(show).not.toHaveBeenCalled()
    reporter.setReady()
    await vi.runAllTimersAsync()
    expect(show).toHaveBeenCalledOnce()
    expect(show.mock.calls[0][0]).toContain('Recovered snapshot')
    reporter.report('storage', 'Could not save')
    await vi.runAllTimersAsync()
    expect(show).toHaveBeenCalledOnce()
  })

  it('serializes dialogs and applies a global cooldown even for distinct failures', async () => {
    vi.useFakeTimers()
    let close!: () => void
    const show = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { close = r }))
      .mockResolvedValue(undefined)
    const reporter = new BoundedErrorReporter(show, vi.fn())
    reporter.setReady()
    reporter.report('one', 'first')
    await vi.advanceTimersByTimeAsync(0)
    reporter.report('two', 'second')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(show).toHaveBeenCalledOnce()
    close()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(show).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('bounds retained categories and message lengths during startup storms', async () => {
    vi.useFakeTimers()
    const show = vi.fn().mockResolvedValue(undefined)
    const reporter = new BoundedErrorReporter(show, vi.fn())
    for (let n = 0; n < 5000; n++) reporter.report(`failure-${n}`, `${n}:${'x'.repeat(5000)}`)
    reporter.setReady()
    await vi.runAllTimersAsync()
    expect(show).toHaveBeenCalledOnce()
    expect(show.mock.calls[0][0].length).toBeLessThan(17_000)
    expect(show.mock.calls[0][0]).toContain('4999:')
  })

  it('falls back synchronously if native async reporting rejects, without leaking rejection', async () => {
    vi.useFakeTimers()
    const fallback = vi.fn()
    const reporter = new BoundedErrorReporter(vi.fn().mockRejectedValue(new Error('dialog failed')), fallback)
    reporter.setReady()
    reporter.report('storage', 'Could not save')
    await vi.runAllTimersAsync()
    expect(fallback).toHaveBeenCalledWith('Could not save')
  })

  it('drains queued shutdown failures synchronously and cancels delayed dialogs', async () => {
    vi.useFakeTimers()
    const show = vi.fn()
    const fallback = vi.fn()
    const reporter = new BoundedErrorReporter(show, fallback)
    reporter.report('storage', 'Unsaved data may remain in memory')
    reporter.flushForShutdown()
    reporter.setReady()
    await vi.runAllTimersAsync()
    expect(fallback).toHaveBeenCalledWith('Unsaved data may remain in memory')
    expect(show).not.toHaveBeenCalled()
  })
})
