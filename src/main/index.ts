// Electron main entry: owns the app lifecycle, the single main window, the tray,
// and the full IPC surface described in shared/types.ts.

import { app, BrowserWindow, ipcMain, dialog, protocol, shell, screen, Menu } from 'electron'
import type { Rectangle, Display, MessageBoxOptions, MenuItemConstructorOptions } from 'electron'
import { isAbsolute, join, resolve, basename } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { accessSync, constants, writeFileSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { IPC, NEEDS_YOU } from '../shared/types'
import type { CreateSessionRequest, Settings } from '../shared/types'
import type { AgentStatus } from '../shared/api'
import type { TrackerSessionInput } from '../shared/tracker'
import { SessionManager } from './session-manager'
import { AssetWatchers } from './assets'
import { assetMime } from '../shared/assets'
import { CrewTray } from './tray'
import { isMac } from './platform'
import { Store } from './store'
import { TranscriptRecorder } from './transcripts'
import { builtinPresets } from './presets'
import { listInstalledSkills } from './skills'
import { scanProjects, recentCommits, resolveLaunch } from './tracker'
import { launch as launchServer, stop as stopServer, status as serverStatus, stopAll as stopAllServers } from './launcher'
import { CHARACTERS } from './characters'

let tray: CrewTray | null = null
let manager: SessionManager
let store: Store
let recorder: TranscriptRecorder
let assets: AssetWatchers
let isQuitting = false
let sessionsRestored = false
// Active workspace (named set) filter shown in the "Change Workspace" menu. null
// = "All Sessions". Held app-wide (mirrors the focused window's filter) so the
// menu can show a radio checkmark; the renderer persists its own per-window copy.
let activeWorkspace: string | null = null

// Persist why the app went down so a "it just disappeared" report is
// diagnosable after the fact. Appends to <userData>/crew-crash.log (falls back
// to the temp dir before the app is ready). Crucially, an uncaught exception in
// the main process no longer kills Crew — it's logged and the app keeps running
// (a menu-bar app vanishing is worse than limping on), and a real native crash
// still surfaces via render-/child-process-gone.
function crashLog(kind: string, detail: string): void {
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  let dir = tmpdir()
  try {
    dir = app.getPath('userData')
  } catch {
    /* before ready */
  }
  try {
    appendFileSync(join(dir, 'crew-crash.log'), line)
  } catch {
    /* best effort */
  }
  console.error('[crew]', kind, detail)
}

process.on('uncaughtException', (err) => crashLog('uncaughtException', (err && err.stack) || String(err)))
process.on('unhandledRejection', (reason) => crashLog('unhandledRejection', String(reason)))
app.on('render-process-gone', (_e, _wc, details) =>
  crashLog('render-process-gone', JSON.stringify(details))
)
app.on('child-process-gone', (_e, details) => crashLog('child-process-gone', JSON.stringify(details)))

// Each window gets the smallest free slot so its view state (grouping, density,
// nav, collapsed groups) persists to its own localStorage namespace (?w=<slot>),
// keeping windows on different screens independent. Freed when the window closes
// so a later window reuses the slot (and its saved layout).
const usedWindowSlots = new Set<number>()
function allocWindowSlot(): number {
  let s = 0
  while (usedWindowSlots.has(s)) s++
  usedWindowSlots.add(s)
  return s
}

// crew-asset:// serves preview files (images/HTML/…) to the renderer in both
// dev (http origin) and prod (file origin). Must be registered before ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'crew-asset', privileges: { secure: true, supportFetchAPI: true, stream: true } }
])

function broadcast(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

/** The window the user is most likely acting on: the focused one, else any. */
function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (t) clearTimeout(t)
    t = setTimeout(fn, ms)
  }
}

/** True if the frame is visible on some connected display (guards stale bounds
 * saved while a now-disconnected monitor was attached). */
function boundsOnSomeDisplay(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return (
      b.x < a.x + a.width - 60 &&
      b.x + b.width > a.x + 60 &&
      b.y < a.y + a.height - 24 &&
      b.y + b.height > a.y + 24
    )
  })
}

function centeredOn(display: Display, width: number, height: number): Rectangle {
  const a = display.workArea
  const w = Math.min(width, a.width - 80)
  const h = Math.min(height, a.height - 80)
  return {
    x: Math.round(a.x + (a.width - w) / 2),
    y: Math.round(a.y + (a.height - h) / 2),
    width: w,
    height: h
  }
}

/** Where the FIRST window opens. It always lands on the primary display — the
 * screen carrying the menu bar, i.e. the one the user is actually sitting in
 * front of. A frame remembered on another display (an external monitor that's
 * since been turned off, put to sleep, or is simply out of view) is the classic
 * "the app launched but there's no window" trap, so the exact remembered frame
 * is only restored when it's on the primary display; otherwise we re-center
 * there at the remembered size. Summoning (tray / activate) can still pull the
 * window to whichever display you're on via revealOnActiveDisplay. */
function defaultBounds(): Rectangle {
  const primary = screen.getPrimaryDisplay()
  const saved = store.windowBounds
  if (saved && boundsOnSomeDisplay(saved)) {
    const savedDisplay = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y })
    if (savedDisplay.id === primary.id) return saved
    return centeredOn(primary, saved.width, saved.height)
  }
  return centeredOn(primary, 1120, 740)
}

/** Where an ADDITIONAL window opens: a monitor that has no Crew window yet (so a
 * second window lands on your other screen), else offset from the current one. */
function newWindowBounds(): Rectangle {
  const usedIds = new Set(
    BrowserWindow.getAllWindows().map((w) => screen.getDisplayMatching(w.getBounds()).id)
  )
  const free = screen.getAllDisplays().find((d) => !usedIds.has(d.id))
  if (free) return centeredOn(free, 1120, 740)
  const f = focusedWindow()?.getBounds()
  if (f) return { x: f.x + 40, y: f.y + 40, width: f.width, height: f.height }
  return defaultBounds()
}

function createWindow(opts: { intro?: boolean; bounds?: Rectangle } = {}): BrowserWindow {
  const intro = opts.intro ?? true
  const w = new BrowserWindow({
    ...(opts.bounds ?? defaultBounds()),
    minWidth: 860,
    minHeight: 540,
    title: 'Crew',
    backgroundColor: '#0A0A0B',
    show: false,
    // macOS hides the titlebar and insets the traffic lights so the renderer
    // draws its own chrome. Windows/Linux keep a native frame so the standard
    // min/max/close controls work — the renderer's own right-side titlebar
    // controls would collide with a Windows title-bar overlay.
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  w.on('ready-to-show', () => {
    w.show()
    w.focus()
  })

  // Links opened from inside the app — terminal OSC 8 hyperlinks, any
  // window.open, or a stray external navigation — go to the user's default
  // browser instead of spawning an in-app Electron window ("webview dialog").
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    let external = true
    try {
      external = new URL(url).origin !== new URL(w.webContents.getURL()).origin
    } catch {
      external = true
    }
    if (external) {
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  // This window's per-window state namespace; released when it's really closed.
  const slot = allocWindowSlot()
  w.on('closed', () => usedWindowSlots.delete(slot))

  // Closing the LAST window hides it (keep running in the tray, menu-bar style);
  // closing an extra window really closes it.
  w.on('close', (e) => {
    if (!isQuitting && BrowserWindow.getAllWindows().length === 1) {
      e.preventDefault()
      w.hide()
    }
  })

  // Remember the frame so Crew reopens where you left it (e.g. a second monitor).
  const saveBounds = debounce(() => {
    if (!w.isDestroyed() && !w.isMinimized() && !w.isFullScreen()) {
      store.setWindowBounds(w.getBounds())
    }
  }, 400)
  w.on('resize', saveBounds)
  w.on('move', saveBounds)

  // Resume the previous session set once the renderer is ready to receive their
  // output. Guarded so it only happens once per app lifetime (the first window).
  w.webContents.once('did-finish-load', () => {
    // Match this window to the app-wide workspace filter (the renderer also
    // persists its own per-window copy across reloads).
    if (activeWorkspace != null) w.webContents.send(IPC.EVT_WORKSPACE, activeWorkspace)
    if (sessionsRestored) return
    sessionsRestored = true
    manager.restore()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const params = new URLSearchParams({ w: String(slot) })
    if (!intro) params.set('intro', '0')
    void w.loadURL(`${devUrl}?${params.toString()}`)
  } else {
    const query: Record<string, string> = { w: String(slot) }
    if (!intro) query.intro = '0'
    void w.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
  return w
}

/** Open an additional window, preferring a monitor without a Crew window. The
 * launch sequence only plays on the first window, not on extra ones. */
function openWindow(): void {
  createWindow({ intro: false, bounds: newWindowBounds() })
}

/** Bring a window onto the primary display — the menu-bar screen the user is in
 * front of — whenever Crew is summoned, so it can't stay stranded on an external
 * monitor that's off or out of view. Only moves the window when it isn't already
 * on the primary display (or is off-screen entirely); size is kept and clamped
 * to fit the work area. */
function revealWindow(w: BrowserWindow): void {
  const primary = screen.getPrimaryDisplay()
  const b = w.getBounds()
  const onPrimary = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).id === primary.id
  if (!onPrimary || !boundsOnSomeDisplay(b)) {
    w.setBounds(centeredOn(primary, b.width, b.height))
  }
}

function showWindow(): void {
  const w = focusedWindow()
  if (!w) {
    createWindow()
    return
  }
  if (w.isMinimized()) w.restore()
  revealWindow(w)
  w.show()
  w.focus()
}

function jumpTo(id: string): void {
  showWindow()
  focusedWindow()?.webContents.send(IPC.EVT_JUMP, id)
}

function openNewSession(): void {
  showWindow()
  focusedWindow()?.webContents.send(IPC.EVT_NEW)
}

/** Switch the active workspace filter: tell the focused window and refresh the
 *  menu checkmark. `name` is a workspace name or null for "All Sessions". */
function setActiveWorkspace(name: string | null): void {
  activeWorkspace = name
  focusedWindow()?.webContents.send(IPC.EVT_WORKSPACE, name)
  rebuildAppMenu()
}

/** Build the macOS application menu. Standard roles are preserved; the File menu
 *  gains New Session / New Window and a "Change Workspace" flyout listing every
 *  saved workspace (radio-checked on the active one) plus "All Sessions". */
function rebuildAppMenu(): void {
  const names = store ? store.workspaceNames() : []
  const workspaceItems: MenuItemConstructorOptions[] = [
    {
      label: 'All Sessions',
      type: 'radio',
      checked: activeWorkspace == null,
      click: () => setActiveWorkspace(null)
    }
  ]
  if (names.length) {
    workspaceItems.push({ type: 'separator' })
    for (const name of names) {
      workspaceItems.push({
        label: name,
        type: 'radio',
        checked: activeWorkspace === name,
        click: () => setActiveWorkspace(name)
      })
    }
  }

  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Session', click: () => openNewSession() },
        { label: 'New Window', click: () => openWindow() },
        { type: 'separator' },
        { label: 'Change Workspace', submenu: workspaceItems },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}


let quitDialogOpen = false

/** Under automation the quit prompt is skipped: Playwright drives Electron with
 * a remote-debugging port and a blocked before-quit would hang app.close().
 * CREW_NO_QUIT_CONFIRM=1 is an explicit override. */
function quitConfirmDisabled(): boolean {
  return (
    process.env.CREW_NO_QUIT_CONFIRM === '1' ||
    app.commandLine.hasSwitch('remote-debugging-port')
  )
}

/** Release resources on the way out. Safe to call once; everything is
 * optional-chained because a redundant second instance never built them. */
function teardown(): void {
  crashLog('quit', 'tearing down')
  recorder?.dispose()
  manager?.disposeAll()
  assets?.disposeAll()
  stopAllServers()
  tray?.destroy()
}

/** Commit to quitting: flips isQuitting so the window-close handler stops
 * hiding and the next before-quit runs teardown instead of re-prompting. */
function reallyQuit(): void {
  isQuitting = true
  app.quit()
}

/** Guard against accidental quits — a reflexive Cmd+Q or a mis-clicked tray
 * item shouldn't silently kill Crew and every running session. Prompt first;
 * only tear down if the user confirms. */
async function confirmQuit(): Promise<void> {
  if (isQuitting) return
  if (quitConfirmDisabled()) {
    reallyQuit()
    return
  }
  if (quitDialogOpen) {
    BrowserWindow.getAllWindows()
      .find((w) => w.isVisible())
      ?.focus()
    return
  }
  quitDialogOpen = true
  const active = manager?.roster().filter((s) => s.status === 'active').length ?? 0
  const parent = BrowserWindow.getAllWindows().find((w) => w.isVisible()) ?? null
  const opts: MessageBoxOptions = {
    type: 'question',
    buttons: ['Quit Crew', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Quit Crew?',
    detail:
      active > 0
        ? `${active} running session${active === 1 ? '' : 's'} will be stopped.`
        : 'Crew will stop running and won’t watch your sessions until reopened.'
  }
  const { response } = parent
    ? await dialog.showMessageBox(parent, opts)
    : await dialog.showMessageBox(opts)
  quitDialogOpen = false
  if (response === 0) reallyQuit()
}

/** GUI-launched apps (Finder/Dock/Spotlight) inherit a minimal PATH that omits
 * shell additions (nvm, bun, ~/.agency, /opt/homebrew, …), so agents such as
 * `copilot` show up as "not found on PATH". Recover the real PATH from a
 * login+interactive shell and merge it into process.env, so both agent
 * detection (whichSync) and session spawns (node-pty) can find the binaries.
 * Terminal launches already have the full PATH; the merge just de-dupes. */
function hydrateShellPath(): void {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  const M = '__CREW_PATH__'
  try {
    // ${PATH} is braced so the marker can't be swallowed into the variable name;
    // spawnSync (not execFileSync) still returns stdout even if an interactive
    // zsh exits non-zero for lack of a TTY.
    const res = spawnSync(shell, ['-ilc', `printf '%s' "${M}\${PATH}${M}"`], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' }
    })
    const shellPath = (res.stdout || '').match(new RegExp(`${M}(.*)${M}`))?.[1]?.trim()
    if (!shellPath) return
    const seen = new Set<string>()
    const merged: string[] = []
    for (const p of [...shellPath.split(':'), ...(process.env.PATH || '').split(':')]) {
      if (p && !seen.has(p)) {
        seen.add(p)
        merged.push(p)
      }
    }
    process.env.PATH = merged.join(':')
  } catch {
    /* keep the inherited PATH */
  }
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
  manager.on('output', (p) => broadcast(IPC.EVT_OUTPUT, p))

  manager.on('state', (info) =>
    broadcast(IPC.EVT_STATE, {
      id: info.id,
      state: info.state,
      stateChangedAt: info.stateChangedAt
    })
  )

  manager.on('roster', (roster) => {
    // During quit, killed sessions emit a final roster asynchronously; the tray
    // and asset watchers are being torn down, so don't touch them.
    if (isQuitting) return
    broadcast(IPC.EVT_ROSTER, roster)
    tray?.update(roster)
    assets.sync(roster)
  })

  manager.on('transition', ({ session, from, to }) => {
    // Notify only when a session ENTERS a needs-you state from a non-needs-you
    // one (covers WORKING→WAITING and IDLE→WAITING without double-firing).
    if (!NEEDS_YOU.includes(to) || NEEDS_YOU.includes(from)) return
    const s = store.settings
    if (!s.notifications) return
    if (s.notifyOnlyWhenUnfocused && BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
    tray?.notify(session, !s.sound)
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.SESSION_CREATE, (_e, req: CreateSessionRequest) => {
    const info = manager.create(req)
    // A new session may introduce new workspace names → refresh the menu flyout.
    if (req.sets && req.sets.length) rebuildAppMenu()
    return info
  })
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
  ipcMain.handle(IPC.SESSION_SET_WORKSPACES, (_e, p: { id: string; sets: string[] }) => {
    manager.setWorkspaces(p.id, p.sets)
    rebuildAppMenu()
  })
  ipcMain.handle(IPC.SESSION_REORDER, (_e, orderedIds: string[]) => manager.reorder(orderedIds))
  ipcMain.handle(IPC.WINDOW_OPEN, () => {
    openWindow()
  })
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
      .map((s) => ({
        presetId: s.presetId,
        command: s.command,
        args: s.args,
        cwd: s.cwd,
        label: s.label,
        id: s.id,
        agentSessionId: s.agentSessionId,
        characterId: s.characterId,
        color: s.color,
        tag: s.tag,
        sets: s.sets
      }))
    const sets = store.upsertSet({ name, sessions })
    // Saving a snapshot also makes every currently-open session a member of this
    // workspace, so existing sessions (not just newly-created ones) can join it.
    manager.addWorkspaceToActive(name)
    rebuildAppMenu()
    return sets
  })
  ipcMain.handle(IPC.SETS_LAUNCH, (_e, name: string) => {
    manager.launchSet(name)
  })
  ipcMain.handle(IPC.SETS_DELETE, (_e, name: string) => {
    const sets = store.deleteSet(name)
    manager.removeWorkspaceEverywhere(name)
    if (activeWorkspace === name) setActiveWorkspace(null)
    rebuildAppMenu()
    return sets
  })
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

  ipcMain.handle(IPC.TRACKER_SCAN, () => {
    // One project per OPEN (active) session — matches the handoff's per-session
    // model, scoped to currently-open sessions.
    const inputs: TrackerSessionInput[] = manager
      .roster()
      .filter((s) => s.status === 'active')
      .map((s) => ({
        id: s.id,
        label: s.label,
        tag: s.tag && s.tag.trim() ? s.tag.trim() : 'Other',
        color: s.color,
        character: s.characterId ?? null,
        createdAt: s.createdAt ?? null,
        lastPromptAt: s.lastPromptAt ?? s.createdAt ?? null,
        cwd: s.cwd,
        agentSessionId: s.agentSessionId ?? null
      }))
    return scanProjects(inputs)
  })
  // Open an external http(s) URL (GitHub / live demo) in the default browser.
  ipcMain.handle(IPC.OPEN_EXTERNAL, (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  // Recent git commits across the open sessions' working dirs, for the Activity feed.
  ipcMain.handle(IPC.ACTIVITY_COMMITS, () => {
    const seen = new Map<string, string>()
    for (const s of manager.roster()) {
      if (s.status !== 'active' || seen.has(s.cwd)) continue
      seen.set(s.cwd, basename(s.cwd) || s.cwd)
    }
    return recentCommits([...seen].map(([cwd, name]) => ({ cwd, name })))
  })
  // Launch / stop / status a project's local dev server (Project Tracker).
  ipcMain.handle(IPC.TRACKER_LAUNCH, async (_e, id: string) => {
    const s = manager.roster().find((x) => x.id === id)
    if (!s) return { ok: false, error: 'Unknown project id.' }
    const meta = await resolveLaunch(s.cwd)
    return launchServer(id, s.cwd, s.label, meta)
  })
  ipcMain.handle(IPC.TRACKER_STOP, (_e, id: string) => stopServer(id))
  ipcMain.handle(IPC.TRACKER_STATUS, () => serverStatus())

  ipcMain.on(IPC.SESSION_INPUT, (_e, p: { id: string; data: string }) =>
    manager.input(p.id, p.data)
  )
  ipcMain.on(IPC.SESSION_RESIZE, (_e, p: { id: string; cols: number; rows: number }) =>
    manager.resize(p.id, p.cols, p.rows)
  )
}

// One running Crew owns the tray, sessions and windows. A second launch (the
// user re-opening the app, or a stale hidden instance being started again) must
// not spin up a duplicate background process — it hands off to the primary,
// which reveals its window on the display the user is actually looking at.
if (!app.requestSingleInstanceLock()) {
  // A redundant second instance: hand off to the primary and exit silently
  // (no quit prompt — this process never showed a window).
  isQuitting = true
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(() => {
  hydrateShellPath()
  store = new Store(join(app.getPath('userData'), 'crew-store.json'))
  recorder = new TranscriptRecorder(join(app.getPath('userData'), 'transcripts'))
  manager = new SessionManager(store, recorder)
  assets = new AssetWatchers((id, list) => broadcast(IPC.EVT_ASSETS, { id, assets: list }))
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
  rebuildAppMenu()
  createWindow()

  tray = new CrewTray({
    onShow: showWindow,
    onNewWindow: openWindow,
    onNewSession: openNewSession,
    onJump: jumpTo,
    onQuit: () => {
      void confirmQuit()
    }
  })

  wireManager()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showWindow()
  })
})
}

app.on('before-quit', (e) => {
  if (isQuitting) {
    teardown()
    return
  }
  // Not yet confirmed. Under automation, allow this quit to proceed (tear down
  // inline, no re-entrant app.quit()). Otherwise hold it and ask.
  if (quitConfirmDisabled()) {
    isQuitting = true
    teardown()
    return
  }
  e.preventDefault()
  void confirmQuit()
})

// Keep running in the tray after the window closes (macOS-style menu-bar app).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
