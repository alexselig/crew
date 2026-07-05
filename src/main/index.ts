// Electron main entry: owns the app lifecycle, the single main window, the tray,
// and the full IPC surface described in shared/types.ts.

import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { accessSync, constants, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { IPC, NEEDS_YOU } from '../shared/types'
import type { CreateSessionRequest, Settings } from '../shared/types'
import type { AgentStatus } from '../shared/api'
import { SessionManager } from './session-manager'
import { AssetWatchers } from './assets'
import { assetMime } from '../shared/assets'
import { CrewTray } from './tray'
import { Store } from './store'
import { TranscriptRecorder } from './transcripts'
import { builtinPresets } from './presets'
import { listInstalledSkills } from './skills'
import { CHARACTERS } from './characters'

let win: BrowserWindow | null = null
let tray: CrewTray | null = null
let manager: SessionManager
let store: Store
let recorder: TranscriptRecorder
let assets: AssetWatchers
let isQuitting = false
let sessionsRestored = false

// crew-asset:// serves preview files (images/HTML/…) to the renderer in both
// dev (http origin) and prod (file origin). Must be registered before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'crew-asset', privileges: { secure: true, supportFetchAPI: true, stream: true } }
])

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 540,
    title: 'Crew',
    backgroundColor: '#0A0A0B',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win?.show())

  // Closing the window hides it (keep running in the tray) unless truly quitting.
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win?.hide()
    }
  })

  win.on('closed', () => {
    win = null
  })

  // Resume the previous session set once the renderer is ready to receive their
  // output. Guarded so it only happens on the first load of the app's lifetime.
  win.webContents.once('did-finish-load', () => {
    if (sessionsRestored) return
    sessionsRestored = true
    manager.restore()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  win.show()
  win.focus()
}

function jumpTo(id: string): void {
  showWindow()
  win?.webContents.send(IPC.EVT_JUMP, id)
}

function openNewSession(): void {
  showWindow()
  win?.webContents.send(IPC.EVT_NEW)
}

function applyLoginItem(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled })
  } catch {
    /* unsupported on this platform */
  }
}

/** Resolve a command on PATH (no external `which` dependency). */
function whichSync(cmd: string): string | null {
  if (!cmd) return null
  if (cmd.includes('/')) {
    try {
      accessSync(cmd, constants.X_OK)
      return cmd
    } catch {
      return null
    }
  }
  for (const dir of (process.env.PATH || '').split(':').filter(Boolean)) {
    const p = join(dir, cmd)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* not in this dir */
    }
  }
  return null
}

function wireManager(): void {
  manager.on('output', (p) => win?.webContents.send(IPC.EVT_OUTPUT, p))

  manager.on('state', (info) =>
    win?.webContents.send(IPC.EVT_STATE, {
      id: info.id,
      state: info.state,
      stateChangedAt: info.stateChangedAt
    })
  )

  manager.on('roster', (roster) => {
    win?.webContents.send(IPC.EVT_ROSTER, roster)
    tray?.update(roster)
    assets.sync(roster)
  })

  manager.on('transition', ({ session, from, to }) => {
    // Notify only when a session ENTERS a needs-you state from a non-needs-you
    // one (covers WORKING→WAITING and IDLE→WAITING without double-firing).
    if (!NEEDS_YOU.includes(to) || NEEDS_YOU.includes(from)) return
    const s = store.settings
    if (!s.notifications) return
    if (s.notifyOnlyWhenUnfocused && win?.isFocused()) return
    tray?.notify(session, !s.sound)
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.SESSION_CREATE, (_e, req: CreateSessionRequest) => manager.create(req))
  ipcMain.handle(IPC.SESSION_CLOSE, (_e, id: string) => {
    manager.close(id)
  })
  ipcMain.handle(IPC.SESSION_RESTART, (_e, id: string) => manager.restart(id))
  ipcMain.handle(IPC.SESSION_RENAME, (_e, p: { id: string; label: string }) =>
    manager.rename(p.id, p.label)
  )
  ipcMain.handle(IPC.SESSION_SET_CHARACTER, (_e, p: { id: string; characterId: string }) =>
    manager.setCharacter(p.id, p.characterId)
  )
  ipcMain.handle(IPC.SESSION_SET_COLOR, (_e, p: { id: string; color: string }) =>
    manager.setColor(p.id, p.color)
  )
  ipcMain.handle(IPC.SESSION_SET_TAG, (_e, p: { id: string; tag: string }) =>
    manager.setTag(p.id, p.tag)
  )
  ipcMain.handle(IPC.SESSION_REORDER, (_e, orderedIds: string[]) => manager.reorder(orderedIds))
  ipcMain.handle(IPC.ROSTER_GET, () => manager.roster())
  ipcMain.handle(IPC.PRESETS_GET, () => builtinPresets())
  ipcMain.handle(IPC.CHARACTERS_GET, () => CHARACTERS)
  ipcMain.handle(IPC.HOME_DIR_GET, () => homedir())
  ipcMain.handle(IPC.AGENTS_DETECT, (): AgentStatus[] =>
    builtinPresets().map((p) => {
      const path = whichSync(p.command)
      return {
        presetId: p.id,
        name: p.name,
        command: p.command,
        available: path != null,
        path,
        installHint: p.installHint
      }
    })
  )
  ipcMain.handle(IPC.SKILLS_LIST, (_e, agent: string) => listInstalledSkills(agent))
  ipcMain.handle(IPC.SETTINGS_GET, () => store.settings)
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_e, patch: Partial<Settings>) => {
    const next = store.updateSettings(patch)
    applyLoginItem(next.launchAtLogin)
    return next
  })
  ipcMain.handle(IPC.SETS_GET, () => store.sets)
  ipcMain.handle(IPC.SETS_SAVE, (_e, name: string) => {
    const sessions = manager
      .roster()
      .filter((s) => s.status === 'active')
      .map((s) => ({ presetId: s.presetId, command: s.command, args: s.args, cwd: s.cwd, label: s.label }))
    return store.upsertSet({ name, sessions })
  })
  ipcMain.handle(IPC.SETS_LAUNCH, (_e, name: string) => {
    manager.launchSet(name)
  })
  ipcMain.handle(IPC.SETS_DELETE, (_e, name: string) => store.deleteSet(name))
  ipcMain.handle(IPC.EVENTS_GET, () => manager.getEvents())
  ipcMain.handle(IPC.ASSETS_LIST, (_e, id: string) => assets.list(id))
  // Both act only on paths the watcher currently knows — no arbitrary FS access.
  ipcMain.handle(IPC.ASSET_REVEAL, (_e, path: string) => {
    if (assets.has(path)) shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.ASSET_OPEN, async (_e, path: string) => {
    if (assets.has(path)) await shell.openPath(path)
  })
  // A path token the agent printed and the user clicked: resolve it against
  // the session cwd and (if it's a real previewable file) allowlist + return it.
  ipcMain.handle(IPC.ASSET_RESOLVE, (_e, p: { id: string; token: string }) => {
    const cwd = assets.cwdOf(p.id)
    if (!cwd || typeof p.token !== 'string' || p.token.length > 1024) return null
    let t = p.token
    if (t === '~' || t.startsWith('~/')) t = join(homedir(), t.slice(1))
    const abs = resolve(isAbsolute(t) ? t : join(cwd, t))
    return assets.pin(p.id, abs)
  })
  ipcMain.handle(IPC.TRANSCRIPT_SEARCH, (_e, query: string) => recorder.search(query))
  ipcMain.handle(IPC.TRANSCRIPT_GET, (_e, id: string) => recorder.read(id))
  ipcMain.handle(IPC.TRANSCRIPT_EXPORT, async (_e, p: { id: string; label: string }) => {
    const text = recorder.read(p.id)
    const safe = p.label.replace(/[^\w.-]+/g, '_').slice(0, 40) || 'session'
    const res = await dialog.showSaveDialog({
      title: 'Export transcript',
      defaultPath: join(homedir(), `crew-${safe}.txt`)
    })
    if (res.canceled || !res.filePath) return false
    try {
      writeFileSync(res.filePath, text)
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(IPC.SESSION_INPUT, (_e, p: { id: string; data: string }) =>
    manager.input(p.id, p.data)
  )
  ipcMain.on(IPC.SESSION_RESIZE, (_e, p: { id: string; cols: number; rows: number }) =>
    manager.resize(p.id, p.cols, p.rows)
  )
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'crew-store.json'))
  recorder = new TranscriptRecorder(join(app.getPath('userData'), 'transcripts'))
  manager = new SessionManager(store, recorder)
  assets = new AssetWatchers((id, list) => win?.webContents.send(IPC.EVT_ASSETS, { id, assets: list }))
  applyLoginItem(store.settings.launchAtLogin)

  // Serve previewable files — only ones the asset watcher has vouched for.
  protocol.handle('crew-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!assets.has(path)) return new Response('Not found', { status: 404 })
      const body = await readFile(path)
      return new Response(body, {
        headers: { 'content-type': assetMime(path), 'cache-control': 'no-cache' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  registerIpc()
  createWindow()

  tray = new CrewTray({
    onShow: showWindow,
    onNewSession: openNewSession,
    onJump: jumpTo,
    onQuit: () => {
      isQuitting = true
      app.quit()
    }
  })

  wireManager()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
  recorder?.dispose()
  manager?.disposeAll()
  assets?.disposeAll()
  tray?.destroy()
})

// Keep running in the tray after the window closes (macOS-style menu-bar app).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
