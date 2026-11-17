import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SessionManager spawns real PTYs; mock node-pty so launching a set can be
// exercised in the node test environment without launching real agents.
const { spawned, fakeSpawn } = vi.hoisted(() => {
  const spawned: number[] = []
  return {
    spawned,
    fakeSpawn: vi.fn(() => {
      spawned.push(Date.now())
      return {
        pid: 1000 + spawned.length,
        onData: vi.fn((_listener: (data: string) => void) => ({ dispose: () => {} })),
        onExit: () => ({ dispose: () => {} }),
        write: vi.fn(),
        resize: () => {},
        kill: vi.fn()
      }
    })
  }
})

vi.mock('node-pty', () => ({ spawn: fakeSpawn, default: { spawn: fakeSpawn } }))

import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'
import type { SessionSet } from '../src/shared/types'

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

  it('preserves a saved session handoff lineage', () => {
    const store = storeWithSet(0)
    store.upsertSet({
      name: 'Recovered',
      sessions: [{
        presetId: 'copilot-cli',
        command: 'copilot',
        args: [],
        cwd: tmpdir(),
        label: 'Recovered',
        id: 'r0',
        agentSessionId: 'fresh-successor',
        priorSessionId: 'original-conversation',
        characterId: 'lion'
      }]
    } as SessionSet)
    const manager = new SessionManager(store)

    const [restored] = manager.launchSet('Recovered')

    expect(restored.agentSessionId).toBe('fresh-successor')
    expect(restored.priorSessionId).toBe('original-conversation')

    manager.disposeAll()
  })

  it('starts a resumed session when it is opened', () => {
    const manager = new SessionManager(storeWithSet(5))
    const launched = manager.launchSet('Recovered')

    manager.wake(launched[2].id)

    expect(spawned.length).toBe(1)

    manager.disposeAll()
  })

  it('reuses a running session without losing its output, input or shutdown ownership', () => {
    const store = storeWithSet(1)
    const manager = new SessionManager(store)
    const [original] = manager.launchSet('Recovered', ['ws_original'])
    manager.wake(original.id)
    manager.setDescription(original.id, 'Current work')
    const proc = fakeSpawn.mock.results[0].value
    const output = vi.fn()
    manager.on('output', output)

    const [reused] = manager.launchSet('Recovered', ['ws_new'])

    expect(reused).toMatchObject({
      id: original.id,
      pid: proc.pid,
      state: 'STARTING',
      description: 'Current work',
      workspaceIds: ['ws_original', 'ws_new']
    })
    proc.onData.mock.calls[0][0]('Still working\r\n')
    vi.advanceTimersByTime(40)
    expect(output).toHaveBeenCalledWith({ id: original.id, data: 'Still working\r\n' })
    manager.wake(original.id)
    manager.input(original.id, 'hello\r')
    expect(proc.write).toHaveBeenCalledWith('hello\r')
    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(manager.roster()).toHaveLength(1)
    expect(store.getSessions()[0].workspaceIds).toEqual(['ws_original', 'ws_new'])

    manager.disposeAll()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('reuses an asleep session on repeated launches without replacing its current metadata', () => {
    const store = storeWithSet(1)
    const manager = new SessionManager(store)
    const [original] = manager.launchSet('Recovered', ['ws_original'])
    manager.setDescription(original.id, 'Keep this note')

    manager.launchSet('Recovered', ['ws_new'])
    const [reused] = manager.launchSet('Recovered')

    expect(reused).toMatchObject({
      id: original.id,
      agentSessionId: original.agentSessionId,
      state: 'ASLEEP',
      description: 'Keep this note',
      workspaceIds: ['ws_original', 'ws_new']
    })
    expect(manager.roster()).toHaveLength(1)
    expect(fakeSpawn).not.toHaveBeenCalled()
    manager.wake(original.id)
    manager.wake(original.id)
    expect(fakeSpawn).toHaveBeenCalledTimes(1)

    manager.disposeAll()
  })

  it('ignores a set that does not exist', () => {
    const manager = new SessionManager(storeWithSet(3))

    expect(manager.launchSet('nope')).toEqual([])

    manager.disposeAll()
  })
})
