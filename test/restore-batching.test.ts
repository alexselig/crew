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
  it('does not spawn every saved agent in one tick', () => {
    const manager = new SessionManager(storeWith(30))

    const first = manager.restore()

    // The whole point: a 30-session roster must not put 30 PTYs on the renderer
    // in the same frame, which is what pegged it and flickered the window.
    expect(first.length).toBeLessThan(30)
    expect(spawned.length).toBeLessThan(30)
    expect(spawned.length).toBeGreaterThan(0)

    manager.disposeAll()
  })

  it('keeps spawning in batches until the whole roster is restored', () => {
    const manager = new SessionManager(storeWith(30))
    manager.restore()
    const afterFirstBatch = spawned.length

    vi.advanceTimersByTime(10_000)

    expect(spawned.length).toBe(30)
    expect(manager.roster()).toHaveLength(30)
    expect(afterFirstBatch).toBeLessThan(30)

    manager.disposeAll()
  })

  it('cancels queued batches on shutdown instead of spawning into a closing app', () => {
    const manager = new SessionManager(storeWith(30))
    manager.restore()
    const atShutdown = spawned.length

    manager.disposeAll()
    vi.advanceTimersByTime(10_000)

    expect(spawned.length).toBe(atShutdown)
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

  it('still restores a small roster immediately, with no batching delay', () => {
    const manager = new SessionManager(storeWith(3))

    expect(manager.restore()).toHaveLength(3)
    expect(spawned.length).toBe(3)

    manager.disposeAll()
  })
})
