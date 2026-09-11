import type { WebContents, Session } from 'electron'
import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isLoopbackHttp } from '../shared/detection'

function isHttp(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const guardedPreviewSessions = new WeakSet<Session>()

/** Only document navigation is restricted; dev-server remote scripts/assets still work. */
export function installPreviewBoundary(host: WebContents, openExternal: (url: string) => void): void {
  host.on('will-attach-webview', (event, prefs, params) => {
    delete prefs.preload
    prefs.nodeIntegration = false
    prefs.contextIsolation = true
    prefs.partition = params.partition = 'persist:crewapp'
    if (!isLoopbackHttp(params.src)) event.preventDefault()
  })
  host.on('did-attach-webview', (_event, guest) => {
    const block = (event: { preventDefault(): void }, url: string): void => {
      if (!isLoopbackHttp(url)) event.preventDefault()
    }
    guest.on('will-navigate', block)
    guest.on('will-frame-navigate', (event) => block(event, event.url))
    guest.on('will-redirect', (event, url) => block(event, url))
    guest.setWindowOpenHandler(({ url }) => {
      if (isHttp(url)) openExternal(url)
      return { action: 'deny' }
    })
    // loadURL / changing a webview's src can bypass will-navigate. The isolated
    // preview partition supplies the final document-request boundary.
    if (!guardedPreviewSessions.has(guest.session)) {
      guardedPreviewSessions.add(guest.session)
      guest.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const document = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame'
        callback({ cancel: document && !isLoopbackHttp(details.url) })
      })
    }
  })
}

type Report = (key: string, detail: string) => void
type NativeShell = {
  openExternal(url: string): Promise<void>
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

/** Preserve Promise<void> IPC contracts: native failures are displayed, not discarded. */
export function createShellActions(
  native: NativeShell,
  hasAsset: (path: string) => boolean,
  report: Report,
  checkExists: (path: string) => void = (path) => accessSync(path, constants.F_OK)
) {
  const run = async (key: string, operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      report(key, `${key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const validateAsset = (path: unknown): string => {
    if (typeof path !== 'string' || !isAbsolute(path) || !hasAsset(path)) {
      throw new Error('This file is not a currently indexed asset. Refresh the session assets and try again.')
    }
    checkExists(path)
    return path
  }
  return {
    openExternal: (url: unknown): Promise<void> => run('Open browser', async () => {
      if (!isHttp(url)) throw new Error('Only valid HTTP or HTTPS links can be opened.')
      await native.openExternal(url)
    }),
    openAsset: (path: unknown): Promise<void> => run('Open asset', async () => {
      const error = await native.openPath(validateAsset(path))
      if (error) throw new Error(error)
    }),
    revealAsset: (path: unknown): Promise<void> => run('Reveal asset', () => {
      // Electron returns void here; only validation and thrown exceptions are detectable.
      native.showItemInFolder(validateAsset(path))
    })
  }
}

const MAX_ERROR_KEYS = 8
const MAX_ERROR_LENGTH = 2000
const ERROR_COOLDOWN_MS = 60_000

/** Bounded, coalesced native warnings; no renderer or app-readiness dependency. */
export class BoundedErrorReporter {
  private ready = false
  private stopped = false
  private active = false
  private nextShowAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Map<string, string>()
  private readonly recent = new Map<string, string>()

  constructor(
    private readonly show: (detail: string) => Promise<unknown>,
    private readonly showSync: (detail: string) => void
  ) {}

  report(key: string, detail: string): void {
    key = key.slice(0, 100)
    detail = detail.slice(0, MAX_ERROR_LENGTH)
    if (this.recent.get(key) === detail) return
    this.remember(this.recent, key, detail)
    this.remember(this.pending, key, detail)
    this.schedule()
  }

  setReady(): void {
    this.ready = true
    this.schedule()
  }

  flushForShutdown(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pending.size) this.fallback(this.takePending())
  }

  private remember(map: Map<string, string>, key: string, detail: string): void {
    map.delete(key)
    map.set(key, detail)
    if (map.size > MAX_ERROR_KEYS) map.delete(map.keys().next().value!)
  }

  private takePending(): string {
    const detail = [...new Set(this.pending.values())].join('\n\n')
    this.pending.clear()
    return detail
  }

  private schedule(): void {
    if (!this.ready || this.stopped || this.active || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, Math.max(0, this.nextShowAt - Date.now()))
    this.timer.unref()
  }

  private fallback(detail: string): void {
    try {
      this.showSync(detail)
    } catch (error) {
      console.error('[crew] Native error reporting unavailable:', detail, error)
    }
  }

  private async drain(): Promise<void> {
    this.active = true
    const detail = this.takePending()
    try {
      await this.show(detail)
    } catch {
      this.fallback(detail)
    } finally {
      this.active = false
      this.nextShowAt = Date.now() + ERROR_COOLDOWN_MS
      this.schedule()
    }
  }
}
