// Menu-bar presence: a template icon plus a glanceable title badge, a context
// menu that jumps straight to sessions needing you, and native notifications on
// the WORKING→WAITING transition (SPEC §7.1, §7.7).

import { Tray, Menu, nativeImage, Notification, type MenuItemConstructorOptions } from 'electron'
import type { SessionInfo } from '../shared/types'
import { NEEDS_YOU } from '../shared/types'
import { getCharacter } from './characters'
import { isMac } from './platform'

// 22×22 template PNG (a ring + center dot). Embedded so no resource-copy step
// is needed at build time.
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAdklEQVR4nMWVSw7AIAhEPTa3b/dmPqVMLQkbxTeiImv9aEV8DLyItwUc8JWAgj6Zk2C0oLYYJELBDNrJDsaXgaoxClbKaPE+T3ftwOiy2mAHdXHnwZ8dRfTyUDqR58aUIwWi4KOSZruIfEIOfuRfjnWSWGsa2Q2gcsWV6PXr7AAAAABJRU5ErkJggg=='

// macOS renders template images (black + alpha) tinted to the menu-bar. On
// Windows/Linux a black icon is invisible on a dark taskbar, so recolor the
// ring/dot to white (keeping the alpha shape) and use it non-templated.
function buildTrayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL('data:image/png;base64,' + ICON_B64)
  if (isMac) {
    img.setTemplateImage(true)
    return img
  }
  const { width, height } = img.getSize()
  const bmp = img.toBitmap() // BGRA, one byte per channel
  for (let i = 0; i < bmp.length; i += 4) {
    bmp[i] = 255 // B
    bmp[i + 1] = 255 // G
    bmp[i + 2] = 255 // R — leave alpha (i+3) so only the shape shows
  }
  return nativeImage.createFromBitmap(bmp, { width, height })
}

export interface TrayCallbacks {
  onShow: () => void
  onNewWindow: () => void
  onNewSession: () => void
  onJump: (id: string) => void
  onQuit: () => void
}

const STATE_LABEL: Record<string, string> = {
  STARTING: 'starting',
  WORKING: 'working',
  WAITING_INPUT: 'waiting for you',
  WAITING_APPROVAL: 'needs approval',
  IDLE: 'idle',
  EXITED: 'exited',
  ERROR: 'error'
}

export class CrewTray {
  private readonly tray: Tray
  private destroyed = false

  constructor(private readonly cb: TrayCallbacks) {
    this.tray = new Tray(buildTrayIcon())
    this.tray.setToolTip('Crew')
    this.tray.on('click', () => this.cb.onShow())
    this.update([])
  }

  update(roster: SessionInfo[]): void {
    // A killed session's async PTY exit can emit one last roster during quit,
    // after the native tray is already gone — updating it then throws
    // "Tray is destroyed". Ignore any updates once we've torn down.
    if (this.destroyed || this.tray.isDestroyed()) return
    const active = roster.filter((s) => s.status === 'active')
    const waiting = active.filter((s) => NEEDS_YOU.includes(s.state))
    const onlyApprovals =
      waiting.length > 0 && waiting.every((s) => s.state === 'WAITING_APPROVAL')
    const working = active.filter((s) => s.state === 'WORKING')

    if (waiting.length > 0) {
      this.tray.setTitle(`${onlyApprovals ? '🟠' : '🔴'} ${waiting.length}`)
    } else if (working.length > 0) {
      this.tray.setTitle('🟢')
    } else {
      this.tray.setTitle('')
    }

    // setTitle is macOS-only; the tooltip carries the same glance on Windows/Linux.
    this.tray.setToolTip(
      waiting.length > 0
        ? `Crew — ${waiting.length} need${waiting.length > 1 ? '' : 's'} you`
        : working.length > 0
          ? `Crew — ${working.length} working`
          : 'Crew'
    )

    this.tray.setContextMenu(this.buildMenu(active, waiting))
  }

  notify(session: SessionInfo, silent = false): void {
    if (this.destroyed) return
    if (!Notification.isSupported()) return
    const ch = getCharacter(session.characterId)
    const n = new Notification({
      title: `${ch?.glyph ?? '●'}  ${session.label}`,
      body: session.state === 'WAITING_APPROVAL' ? 'needs your approval' : 'needs your input',
      silent
    })
    n.on('click', () => this.cb.onJump(session.id))
    n.show()
  }

  destroy(): void {
    this.destroyed = true
    this.tray.destroy()
  }

  private buildMenu(active: SessionInfo[], waiting: SessionInfo[]): Menu {
    const items: MenuItemConstructorOptions[] = [
      { label: '＋  New Session', click: () => this.cb.onNewSession() },
      { label: '⧉  New Window', click: () => this.cb.onNewWindow() },
      { type: 'separator' }
    ]

    if (waiting.length > 0) {
      items.push({ label: 'Needs you', enabled: false })
      for (const s of waiting) {
        const ch = getCharacter(s.characterId)
        items.push({
          label: `${ch?.glyph ?? '●'}  ${s.label} — ${STATE_LABEL[s.state]}`,
          click: () => this.cb.onJump(s.id)
        })
      }
      items.push({ type: 'separator' })
    }

    const others = active.filter((s) => !waiting.includes(s))
    if (others.length > 0) {
      items.push({ label: 'Sessions', enabled: false })
      for (const s of others) {
        const ch = getCharacter(s.characterId)
        items.push({
          label: `${ch?.glyph ?? '●'}  ${s.label} — ${STATE_LABEL[s.state]}`,
          click: () => this.cb.onJump(s.id)
        })
      }
      items.push({ type: 'separator' })
    }

    items.push(
      { label: 'Show Crew', click: () => this.cb.onShow() },
      { label: 'Quit Crew', click: () => this.cb.onQuit() }
    )

    return Menu.buildFromTemplate(items)
  }
}
