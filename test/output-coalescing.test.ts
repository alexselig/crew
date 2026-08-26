import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SessionManager spawns real PTYs. Mock node-pty so we can drive output by hand:
// these tests are about how main forwards PTY bytes to the renderer, not about
// running a shell.
const { emitters, fakeSpawn } = vi.hoisted(() => {
  const emitters: ((data: string) => void)[] = []
  return {
    emitters,
    fakeSpawn: vi.fn(() => ({
      pid: 1000 + emitters.length,
      onData: (cb: (data: string) => void) => {
        emitters.push(cb)
        return { dispose: () => {} }
      },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {}
    }))
  }
})

vi.mock('node-pty', () => ({ spawn: fakeSpawn, default: { spawn: fakeSpawn } }))

import { SessionManager } from '../src/main/session-manager'
import { Store, type PersistedSession } from '../src/main/store'

// Mirrors OUTPUT_FLUSH_MS / PENDING_CAP in session-manager.
const FLUSH_MS = 40
const CAP = 512 * 1024

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
  const path = join(mkdtempSync(join(tmpdir(), 'crew-output-')), 'store.json')
  const store = new Store(path)
  store.saveSessions(Array.from({ length: count }, (_, i) => session(i)))
  return store
}

/** Restore a roster fully, returning the manager and every message it sends out. */
function running(count: number): {
  manager: SessionManager
  sent: { id: string; data: string }[]
} {
  const manager = new SessionManager(storeWith(count))
  manager.restore()
  vi.advanceTimersByTime(10_000)
  const sent: { id: string; data: string }[] = []
  manager.on('output', (msg: { id: string; data: string }) => sent.push(msg))
  return { manager, sent }
}

beforeEach(() => {
  emitters.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('forwarding PTY output to the renderer', () => {
  it('sends one message per session per flush, not one per chunk', () => {
    const { manager, sent } = running(1)

    for (let i = 0; i < 500; i++) emitters[0]('chunk\r\n')
    // Nothing has crossed to the renderer yet: 500 chunks are still one screen.
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent).toHaveLength(1)
    expect(sent[0].data).toBe('chunk\r\n'.repeat(500))

    manager.disposeAll()
  })

  it('collapses a whole roster bursting at once into one message each', () => {
    const { manager, sent } = running(30)

    // What actually happens at launch: every resumed agent replays its
    // conversation simultaneously. Unbatched this is 30 x 200 IPC messages.
    for (let i = 0; i < 200; i++) {
      for (const emit of emitters) emit('replay\r\n')
    }
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent).toHaveLength(30)
    expect(new Set(sent.map((m) => m.id)).size).toBe(30)

    manager.disposeAll()
  })

  it('keeps output flowing across successive flushes', () => {
    const { manager, sent } = running(1)

    emitters[0]('one')
    vi.advanceTimersByTime(FLUSH_MS)
    emitters[0]('two')
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent.map((m) => m.data)).toEqual(['one', 'two'])

    manager.disposeAll()
  })

  it('keeps the tail, not the head, when a session outruns the buffer', () => {
    const { manager, sent } = running(1)

    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 20; i++) emitters[0](chunk)
    emitters[0]('THE-END')
    vi.advanceTimersByTime(FLUSH_MS)

    const data = sent.map((m) => m.data).join('')
    // A megabyte of scrollback the terminal would discard anyway must not be
    // held in memory or shipped over IPC — but the newest bytes are the ones
    // the user is actually looking at, so those survive.
    expect(data.length).toBeLessThanOrEqual(CAP + 200)
    expect(data.endsWith('THE-END')).toBe(true)

    manager.disposeAll()
  })

  it('says so when it trims, rather than passing off a gap as the real output', () => {
    const { manager, sent } = running(1)

    for (let i = 0; i < 20; i++) emitters[0]('y'.repeat(64 * 1024))
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent[0].data).toContain('trimmed')

    manager.disposeAll()
  })

  it('does not annotate output that fit', () => {
    const { manager, sent } = running(1)

    emitters[0]('small')
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent[0].data).toBe('small')

    manager.disposeAll()
  })

  it('stops the flush timer once everything is delivered', () => {
    const { manager } = running(1)
    // The manager keeps its own status tick running, so measure the delta.
    const idle = vi.getTimerCount()

    emitters[0]('hi')
    expect(vi.getTimerCount()).toBe(idle + 1)
    vi.advanceTimersByTime(FLUSH_MS * 3)

    // An idle roster should cost nothing: no timer left ticking 25 times a second.
    expect(vi.getTimerCount()).toBe(idle)

    manager.disposeAll()
  })

  it('delivers buffered output before the window goes away', () => {
    const { manager, sent } = running(1)

    emitters[0]('last words')
    manager.disposeAll()

    expect(sent.map((m) => m.data)).toEqual(['last words'])
  })

  it('drops buffered output for a session that was closed', () => {
    const { manager, sent } = running(2)

    emitters[0]('for a terminal that no longer exists')
    manager.close('s0')
    vi.advanceTimersByTime(FLUSH_MS)

    expect(sent).toHaveLength(0)

    manager.disposeAll()
  })
})
