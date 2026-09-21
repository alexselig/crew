import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression: agent panes that render wrapped, fragmented, half-blank output.
 *
 * The PTY was always spawned at a hardcoded 100x30 while the pane it draws into
 * is whatever xterm fitted — commonly ~160 columns on a large display. A CLI
 * that right-aligns a column, or redraws a status line in place, then writes to
 * column 100 of a 160-column grid: durations land in the middle of the pane,
 * in-place redraws miss their own previous line and pile up as stranded
 * prefixes ("Ve", "Veri", "Verifyi"), and long lines wrap early, leaving most
 * of the pane blank. It looks like a renderer fault; it is a size disagreement.
 *
 * The pane reports its size as soon as it mounts, which for a session started
 * from an already-open pane is BEFORE the PTY exists. resize() dropped that
 * report on the floor (no proc yet) and nothing ever re-sent it, so the process
 * spent its whole life believing it had 100 columns.
 */
const { spawnOptions, resizes, fakeSpawn } = vi.hoisted(() => {
  const spawnOptions: { cols: number; rows: number }[] = []
  const resizes: { cols: number; rows: number }[] = []
  return {
    spawnOptions,
    resizes,
    fakeSpawn: vi.fn((_cmd: string, _args: string[], opts: { cols: number; rows: number }) => {
      spawnOptions.push({ cols: opts.cols, rows: opts.rows })
      return {
        pid: 2000 + spawnOptions.length,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        resize: (cols: number, rows: number) => {
          resizes.push({ cols, rows })
        },
        kill: () => {}
      }
    })
  }
})

vi.mock('node-pty', () => ({ spawn: fakeSpawn, default: { spawn: fakeSpawn } }))

import { SessionManager } from '../src/main/session-manager'
import { Store, type PersistedSession } from '../src/main/store'

function storeWithOne(): Store {
  const path = join(mkdtempSync(join(tmpdir(), 'crew-ptysize-')), 'store.json')
  const store = new Store(path)
  store.saveSessions([
    {
      id: 's0',
      presetId: 'copilot-cli',
      command: 'copilot',
      args: [],
      cwd: tmpdir(),
      label: 'Session 0',
      characterId: 'lion',
      color: '#ff7a3c',
      sets: [],
      workspaceIds: [],
      agentSessionId: 'agent-0',
      createdAt: 1,
      lastPromptAt: 1
    } as PersistedSession
  ])
  return store
}

beforeEach(() => {
  spawnOptions.length = 0
  resizes.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PTY size agrees with the pane it draws into', () => {
  it('spawns at the size the pane already reported', () => {
    const manager = new SessionManager(storeWithOne())
    manager.restore()

    // The pane is mounted and fitted before the user starts the session, so its
    // size arrives while proc is still null.
    manager.resize('s0', 161, 45)

    manager.wake('s0')
    vi.advanceTimersByTime(10_000)

    expect(spawnOptions).toHaveLength(1)
    expect(spawnOptions[0]).toEqual({ cols: 161, rows: 45 })

    manager.disposeAll()
  })

  it('still spawns at the default when the pane never reported a size', () => {
    const manager = new SessionManager(storeWithOne())
    manager.restore()
    manager.wake('s0')
    vi.advanceTimersByTime(10_000)

    expect(spawnOptions).toHaveLength(1)
    expect(spawnOptions[0].cols).toBeGreaterThan(0)
    expect(spawnOptions[0].rows).toBeGreaterThan(0)

    manager.disposeAll()
  })

  it('remembers a size reported before spawn and applies it to a later resize', () => {
    const manager = new SessionManager(storeWithOne())
    manager.restore()

    manager.resize('s0', 161, 45)
    manager.wake('s0')
    vi.advanceTimersByTime(10_000)

    // A pane that has not changed size sends nothing more; the process must
    // already be correct rather than waiting for a resize that never comes.
    expect(resizes).toHaveLength(0)
    expect(spawnOptions[0]).toEqual({ cols: 161, rows: 45 })

    manager.disposeAll()
  })
})
