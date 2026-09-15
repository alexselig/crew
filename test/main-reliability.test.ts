import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { transpileModule } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/shared/types'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const traySource = readFileSync(new URL('../src/main/tray.ts', import.meta.url), 'utf8')

describe('main-process reliability integration', () => {
  it('keeps a visible window on its connected secondary display when summoned', () => {
    const helpers = source.slice(
      source.indexOf('function boundsOnSomeDisplay('),
      source.indexOf('function defaultBounds(')
    )
    const revealWindow = source.slice(
      source.indexOf('function revealWindow('),
      source.indexOf('function showWindow(')
    )
    const movedTo: unknown[] = []
    const displays = [
      { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
      { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
    ]
    const javascript = transpileModule(
      `${helpers}\n${revealWindow}\nrevealWindow(window)`,
      {}
    ).outputText

    runInNewContext(javascript, {
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays[0],
        getDisplayNearestPoint: () => displays[1]
      },
      window: {
        getBounds: () => ({ x: 1600, y: 100, width: 1120, height: 740 }),
        setBounds: (bounds: unknown) => movedTo.push(bounds)
      }
    })

    expect(movedTo).toEqual([])
  })

  it('restores saved bounds on a connected secondary display', () => {
    const placement = source.slice(
      source.indexOf('function boundsOnSomeDisplay('),
      source.indexOf('/** Where an ADDITIONAL window opens:')
    )
    const saved = { x: 1600, y: 100, width: 1120, height: 740 }
    const displays = [
      { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
      { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
    ]
    const javascript = transpileModule(
      `${placement}\nglobalThis.result = defaultBounds()`,
      {}
    ).outputText
    const context = {
      result: undefined,
      store: { windowBounds: saved },
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays[0],
        getDisplayNearestPoint: () => displays[1]
      }
    }

    runInNewContext(javascript, context)

    expect(context.result).toEqual(saved)
  })

  it('moves an off-screen summoned window to the primary display', () => {
    const helpers = source.slice(
      source.indexOf('function boundsOnSomeDisplay('),
      source.indexOf('function defaultBounds(')
    )
    const revealWindow = source.slice(
      source.indexOf('function revealWindow('),
      source.indexOf('function showWindow(')
    )
    const movedTo: unknown[] = []
    const primary = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
    const javascript = transpileModule(
      `${helpers}\n${revealWindow}\nrevealWindow(window)`,
      {}
    ).outputText

    runInNewContext(javascript, {
      screen: {
        getAllDisplays: () => [primary],
        getPrimaryDisplay: () => primary
      },
      window: {
        getBounds: () => ({ x: 1600, y: 100, width: 1120, height: 740 }),
        setBounds: (bounds: unknown) => movedTo.push(bounds)
      }
    })

    expect(movedTo).toEqual([{ x: 160, y: 80, width: 1120, height: 740 }])
  })

  it('centers and clamps disconnected saved bounds on the primary display', () => {
    const placement = source.slice(
      source.indexOf('function boundsOnSomeDisplay('),
      source.indexOf('/** Where an ADDITIONAL window opens:')
    )
    const primary = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
    const javascript = transpileModule(
      `${placement}\nglobalThis.result = defaultBounds()`,
      {}
    ).outputText
    const context = {
      result: undefined,
      store: { windowBounds: { x: 1600, y: 100, width: 1800, height: 1200 } },
      screen: {
        getAllDisplays: () => [primary],
        getPrimaryDisplay: () => primary
      }
    }

    runInNewContext(javascript, context)

    expect(context.result).toEqual({ x: 40, y: 40, width: 1360, height: 820 })
  })

  it('forwards autopilot-only roster changes without a fingerprint or state-change gate', () => {
    // Execute the entry point's real forwarding functions, without booting Crew
    // or constructing its PTYs, persistence, windows, or provider integrations.
    const broadcast = source.slice(source.indexOf('function broadcast('), source.indexOf('function focusedWindow('))
    const wireManager = source.slice(source.indexOf('function wireManager('), source.indexOf('function registerIpc('))
    const manager = new EventEmitter()
    const received: Array<{ channel: string; roster: Array<{ autopilot: boolean }> }> = []
    const window = {
      webContents: {
        send: (channel: string, roster: Array<{ autopilot: boolean }>) => {
          received.push({ channel, roster: structuredClone(roster) })
        }
      }
    }
    const javascript = transpileModule(`${broadcast}\n${wireManager}\nwireManager()`, {}).outputText
    runInNewContext(javascript, {
      manager,
      BrowserWindow: { getAllWindows: () => [window] },
      IPC,
      isQuitting: false,
      tray: null,
      assets: { sync: () => {} }
    })
    const session = { id: 'same-session', state: 'WORKING', stateChangedAt: 123, autopilot: false }
    manager.emit('roster', [{ ...session }])
    manager.emit('roster', [{ ...session, autopilot: true }])
    manager.emit('roster', [{ ...session, autopilot: false }])
    expect(received.map(({ channel }) => channel)).toEqual([IPC.EVT_ROSTER, IPC.EVT_ROSTER, IPC.EVT_ROSTER])
    expect(received.map(({ roster }) => roster[0].autopilot)).toEqual([false, true, false])
  })

  it('installs the preview boundary before any guest can attach', () => {
    expect(source).toContain('installPreviewBoundary(w.webContents')
    expect(source).not.toContain("params.src = 'about:blank'")
  })

  it('uses visible caught shell actions at every browser and asset boundary', () => {
    expect(source).not.toContain('void shell.openExternal')
    expect(source).toContain("shellActions.openAsset(path)")
    expect(source).toContain("shellActions.revealAsset(path)")
  })

  it('wires both persistence callbacks and enables queued native reporting', () => {
    expect(source).toMatch(/new Store\([^\n]+reportStorageError\)/)
    expect(source).toMatch(/new TranscriptRecorder\([^\n]+reportStorageError\)/)
    expect(source).toContain('errorReporter.setReady()')
  })

  it('suppresses native notifications while any Crew window is focused', () => {
    const broadcast = source.slice(source.indexOf('function broadcast('), source.indexOf('function focusedWindow('))
    const wireManager = source.slice(source.indexOf('function wireManager('), source.indexOf('function registerIpc('))
    const manager = new EventEmitter()
    const notify = vi.fn()
    const suppress = vi.fn()
    const javascript = transpileModule(`${broadcast}\n${wireManager}\nwireManager()`, {}).outputText

    runInNewContext(javascript, {
      manager,
      BrowserWindow: { getAllWindows: () => [{ isFocused: () => true }] },
      IPC,
      NEEDS_YOU: ['WAITING_INPUT', 'WAITING_APPROVAL'],
      isQuitting: false,
      tray: { notify, suppress, update: vi.fn() },
      assets: { sync: () => {} },
      store: { settings: { notifications: true, notifyOnlyWhenUnfocused: false, sound: true } }
    })

    const session = { id: 'focused', state: 'WAITING_INPUT' }
    manager.emit('transition', { session, from: 'WORKING', to: 'WAITING_INPUT' })

    expect(suppress).toHaveBeenCalledWith('focused')
    expect(notify).not.toHaveBeenCalled()
  })

  it('delivers native notifications while Crew is in the background', () => {
    const broadcast = source.slice(source.indexOf('function broadcast('), source.indexOf('function focusedWindow('))
    const wireManager = source.slice(source.indexOf('function wireManager('), source.indexOf('function registerIpc('))
    const manager = new EventEmitter()
    const notify = vi.fn()
    const suppress = vi.fn()
    const javascript = transpileModule(`${broadcast}\n${wireManager}\nwireManager()`, {}).outputText

    runInNewContext(javascript, {
      manager,
      BrowserWindow: { getAllWindows: () => [{ isFocused: () => false }] },
      IPC,
      NEEDS_YOU: ['WAITING_INPUT', 'WAITING_APPROVAL'],
      isQuitting: false,
      tray: { notify, suppress, update: vi.fn() },
      assets: { sync: () => {} },
      store: { settings: { notifications: true, notifyOnlyWhenUnfocused: false, sound: false } }
    })

    const session = { id: 'background', state: 'WAITING_INPUT' }
    manager.emit('transition', { session, from: 'WORKING', to: 'WAITING_INPUT' })

    expect(notify).toHaveBeenCalledWith(session, true)
    expect(suppress).not.toHaveBeenCalled()
  })

  it('integrates queued notifications with tray display and actual session input', () => {
    expect(traySource).toContain('new NotificationCoordinator(')
    expect(traySource).toContain('this.notifications.queue(')
    expect(traySource).toContain('acknowledge(id: string): void')
    expect(traySource).toContain('suppress(id: string): void')
    expect(traySource).toContain(
      'this.notifications.reconcile(new Set(active.map((session) => session.id)))'
    )
    expect(traySource).toContain('this.notifications.dispose()')
    expect(source).toContain('tray?.suppress(session.id)')
    expect(source).toContain('tray?.acknowledge(p.id)')
  })

  it('stops producers before recorder flush and drains shutdown warnings synchronously', () => {
    const teardown = source.slice(source.indexOf('function teardown()'), source.indexOf('function reallyQuit()'))
    expect(teardown.indexOf('manager?.disposeAll()')).toBeLessThan(teardown.indexOf('recorder?.dispose()'))
    expect(teardown.indexOf('agentRunner?.disposeAll()')).toBeLessThan(teardown.indexOf('recorder?.dispose()'))
    expect(teardown).toContain('errorReporter.flushForShutdown()')
  })
})
