// Electron main entry: owns the app lifecycle, the single main window, the tray,
// and the full IPC surface described in shared/types.ts.

import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { accessSync, constants } from 'node:fs'
import { IPC, NEEDS_YOU } from '../shared/types'
import type { CreateSessionRequest, Settings } from '../shared/types'
import type { AgentStatus } from '../shared/api'
import { SessionManager } from './session-manager'
import { CrewTray } from './tray'
import { Store } from './store'
import { builtinPresets } from './presets'
import { CHARACTERS } from './characters'

let win: BrowserWindow | null = null
let tray: CrewTray | null = null
let manager: SessionManager
let store: Store
let isQuitting = false
let sessionsRestored = false

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 540,
    title: 'Crew',
    backgroundColor: '#0f1115',
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
    const set = store.sets.find((s) => s.name === name)
    if (!set) return
    for (const d of set.sessions) {
      manager.create({ presetId: d.presetId, command: d.command, args: d.args, cwd: d.cwd, label: d.label })
    }
  })
  ipcMain.handle(IPC.SETS_DELETE, (_e, name: string) => store.deleteSet(name))

  ipcMain.on(IPC.SESSION_INPUT, (_e, p: { id: string; data: string }) =>
    manager.input(p.id, p.data)
  )
  ipcMain.on(IPC.SESSION_RESIZE, (_e, p: { id: string; cols: number; rows: number }) =>
    manager.resize(p.id, p.cols, p.rows)
  )
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'crew-store.json'))
  manager = new SessionManager(store)
  applyLoginItem(store.settings.launchAtLogin)

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
  manager?.disposeAll()
  tray?.destroy()
})

// Keep running in the tray after the window closes (macOS-style menu-bar app).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
