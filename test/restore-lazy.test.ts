import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SessionManager spawns real PTYs. Mock node-pty so restore() can be exercised
// in the node test environment — we only care how MANY spawns happen, and when.
const { spawned, fakeSpawn } = vi.hoisted(() => {
  const spawned: { at: number }[] = []
  return {
    spawned,
    fakeSpawn: vi.fn(() => {
      spawned.push({ at: Date.now() })
      return {
        pid: 1000 + spawned.length,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        resize: () => {},
        kill: () => {}
      }
    })
  }
})

vi.mock('node-pty', () => ({ spawn: fakeSpawn, default: { spawn: fakeSpawn } }))

import { SessionManager } from '../src/main/session-manager'
import { Store, type PersistedSession } from '../src/main/store'

// Mirrors RESTORE_BATCH_GAP_MS in session-manager.
const RESTORE_GAP = 400

function session(i: number): PersistedSession {
  return {
    id: `s${i}`,
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: tmpdir(),
    label: `Session ${i}`,
    characterId: 'lion',
    color: '#ff7a3c',
    sets: [],
    workspaceIds: [],
    agentSessionId: `agent-${i}`,
    createdAt: 1,
    lastPromptAt: 1
  } as PersistedSession
}

function storeWith(count: number): Store {
  const path = join(mkdtempSync(join(tmpdir(), 'crew-restore-')), 'store.json')
  const store = new Store(path)
  store.saveSessions(Array.from({ length: count }, (_, i) => session(i)))
  return store
}

beforeEach(() => {
  spawned.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('restoring a large roster', () => {
  it('brings the whole roster back without starting a single agent', () => {
    const manager = new SessionManager(storeWith(30))

    const restored = manager.restore()

    // The whole point: reviving 30 agents at once put 30 live terminals on one
    // renderer and exhausted it. The roster is fully present and labelled; none
    // of it is running.
    expect(restored).toHaveLength(30)
    expect(restored.every((s) => s.state === 'ASLEEP')).toBe(true)
    expect(spawned.length).toBe(0)

    manager.disposeAll()
  })

  it('leaves them asleep however long the app runs', () => {
    const manager = new SessionManager(storeWith(30))
    manager.restore()

    vi.advanceTimersByTime(10 * 60_000)

    // Nothing on a timer may quietly start them behind the user's back - that
    // would just reintroduce the storm a few minutes later.
    expect(spawned.length).toBe(0)
    expect(manager.roster()).toHaveLength(30)

    manager.disposeAll()
  })

  it('starts a session when it is opened', () => {
    const manager = new SessionManager(storeWith(30))
    const restored = manager.restore()

    manager.wake(restored[7].id)

    expect(spawned.length).toBe(1)
    expect(manager.roster().find((s) => s.id === restored[7].id)?.state).toBe('STARTING')

    manager.disposeAll()
  })

  it('does not start a session twice when it is opened again', () => {
    const manager = new SessionManager(storeWith(30))
    const restored = manager.restore()

    manager.wake(restored[0].id)
    manager.wake(restored[0].id)
    manager.wake(restored[0].id)

    expect(spawned.length).toBe(1)

    manager.disposeAll()
  })

  it('starts a session when the user types into it', () => {
    const manager = new SessionManager(storeWith(30))
    const restored = manager.restore()

    manager.input(restored[3].id, 'hello\r')

    expect(spawned.length).toBe(1)

    manager.disposeAll()
  })

  it('does not spawn into a closing app', () => {
    const manager = new SessionManager(storeWith(30))
    manager.restore()

    manager.disposeAll()
    vi.advanceTimersByTime(10_000)

    expect(spawned.length).toBe(0)
  })

  it('never prunes not-yet-spawned sessions from the saved roster', () => {
    const store = storeWith(30)
    const manager = new SessionManager(store)
    manager.restore()

    // A save fires on nearly every event, so one lands long before the last
    // batch has spawned. It must not treat "not spawned yet" as "removed".
    manager.disposeAll()

    expect(store.getSessions()).toHaveLength(30)
  })

  it('keeps the whole roster when quit lands mid-restore', () => {
    const store = storeWith(30)
    const manager = new SessionManager(store)
    manager.restore()
    vi.advanceTimersByTime(RESTORE_GAP * 2)

    manager.disposeAll()

    expect(store.getSessions()).toHaveLength(30)
  })

  it('does not resurrect a session closed before its batch spawned', () => {
    const store = storeWith(30)
    const manager = new SessionManager(store)
    manager.restore()

    manager.close('s29')
    vi.advanceTimersByTime(10_000)
    manager.disposeAll()

    const saved = store.getSessions().map((s) => s.id)
    expect(saved).toHaveLength(29)
    expect(saved).not.toContain('s29')
  })

  it('keeps a woken session asleep-free across a persist round trip', () => {
    const store = storeWith(3)
    const manager = new SessionManager(store)
    const restored = manager.restore()
    manager.wake(restored[1].id)

    manager.disposeAll()

    // Sleeping is a property of "not opened yet in this run", not of the saved
    // session, so nothing about it may leak into the store.
    expect(store.getSessions()).toHaveLength(3)
  })
})
