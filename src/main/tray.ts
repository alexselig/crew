// Menu-bar presence: a template icon plus a glanceable title badge, a context
// menu that jumps straight to sessions needing you, and native notifications on
// the WORKING→WAITING transition (SPEC §7.1, §7.7).

import { Tray, Menu, nativeImage, Notification, type MenuItemConstructorOptions } from 'electron'
import type { SessionInfo } from '../shared/types'
import { NEEDS_YOU } from '../shared/types'
import { getCharacter } from './characters'

// 22×22 template PNG (a ring + center dot). Embedded so no resource-copy step
// is needed at build time.
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAdklEQVR4nMWVSw7AIAhEPTa3b/dmPqVMLQkbxTeiImv9aEV8DLyItwUc8JWAgj6Zk2C0oLYYJELBDNrJDsaXgaoxClbKaPE+T3ftwOiy2mAHdXHnwZ8dRfTyUDqR58aUIwWi4KOSZruIfEIOfuRfjnWSWGsa2Q2gcsWV6PXr7AAAAABJRU5ErkJggg=='

export interface TrayCallbacks {
  onShow: () => void
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

  constructor(private readonly cb: TrayCallbacks) {
    const img = nativeImage.createFromDataURL('data:image/png;base64,' + ICON_B64)
    img.setTemplateImage(true)
    this.tray = new Tray(img)
    this.tray.setToolTip('Crew')
    this.tray.on('click', () => this.cb.onShow())
    this.update([])
  }

  update(roster: SessionInfo[]): void {
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

    this.tray.setContextMenu(this.buildMenu(active, waiting))
  }

  notify(session: SessionInfo, silent = false): void {
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
    this.tray.destroy()
  }

  private buildMenu(active: SessionInfo[], waiting: SessionInfo[]): Menu {
    const items: MenuItemConstructorOptions[] = [
      { label: '＋  New Session', click: () => this.cb.onNewSession() },
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
