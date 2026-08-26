import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SessionManager spawns real PTYs; mock node-pty so launching a set can be
// exercised in the node test environment. Only the count of spawns matters.
const { spawned, fakeSpawn } = vi.hoisted(() => {
  const spawned: number[] = []
  return {
    spawned,
    fakeSpawn: vi.fn(() => {
      spawned.push(Date.now())
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
import { Store } from '../src/main/store'

function storeWithSet(count: number): Store {
  const path = join(mkdtempSync(join(tmpdir(), 'crew-sets-')), 'store.json')
  const store = new Store(path)
  store.upsertSet({
    name: 'Recovered',
    sessions: Array.from({ length: count }, (_, i) => ({
      presetId: 'copilot-cli',
      command: 'copilot',
      args: [],
      cwd: tmpdir(),
      label: `Recovered ${i}`,
      id: `r${i}`,
      agentSessionId: `agent-r${i}`,
      characterId: 'lion'
    }))
  })
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

describe('resuming a saved set', () => {
  it('puts every session on the roster', () => {
    const manager = new SessionManager(storeWithSet(36))

    const launched = manager.launchSet('Recovered')

    expect(launched).toHaveLength(36)
    expect(manager.roster()).toHaveLength(36)

    manager.disposeAll()
  })

  it('does not boot 36 agents at once', () => {
    const manager = new SessionManager(storeWithSet(36))

    manager.launchSet('Recovered')
    vi.advanceTimersByTime(60_000)

    // Same rule as restore: a set can be dozens of sessions, and starting them
    // all together is what pinned the renderer.
    expect(spawned.length).toBe(0)
    expect(manager.roster().every((s) => s.state === 'ASLEEP')).toBe(true)

    manager.disposeAll()
  })

  it('joins the workspace being viewed, so the sessions are actually visible', () => {
    const manager = new SessionManager(storeWithSet(3))

    manager.launchSet('Recovered', ['ws_aug'])

    // The bug this covers: resuming a set under an active workspace filter put
    // the sessions outside it, so the click looked like it had done nothing.
    expect(manager.roster().every((s) => s.workspaceIds?.includes('ws_aug'))).toBe(true)

    manager.disposeAll()
  })

  it('leaves membership alone when no workspace is being viewed', () => {
    const manager = new SessionManager(storeWithSet(3))

    manager.launchSet('Recovered')

    expect(manager.roster().every((s) => (s.workspaceIds ?? []).length === 0)).toBe(true)

    manager.disposeAll()
  })

  it('starts a resumed session when it is opened', () => {
    const manager = new SessionManager(storeWithSet(5))
    const launched = manager.launchSet('Recovered')

    manager.wake(launched[2].id)

    expect(spawned.length).toBe(1)

    manager.disposeAll()
  })

  it('ignores a set that does not exist', () => {
    const manager = new SessionManager(storeWithSet(3))

    expect(manager.launchSet('nope')).toEqual([])

    manager.disposeAll()
  })
})
