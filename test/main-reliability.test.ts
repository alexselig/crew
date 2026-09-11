import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { transpileModule } from 'typescript'
import { describe, expect, it } from 'vitest'
import { IPC } from '../src/shared/types'

const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

describe('main-process reliability integration', () => {
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

  it('stops producers before recorder flush and drains shutdown warnings synchronously', () => {
    const teardown = source.slice(source.indexOf('function teardown()'), source.indexOf('function reallyQuit()'))
    expect(teardown.indexOf('manager?.disposeAll()')).toBeLessThan(teardown.indexOf('recorder?.dispose()'))
    expect(teardown.indexOf('agentRunner?.disposeAll()')).toBeLessThan(teardown.indexOf('recorder?.dispose()'))
    expect(teardown).toContain('errorReporter.flushForShutdown()')
  })
})
