import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync, fsyncSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  primaryPath: '',
  countPrimaryReads: false,
  primaryReads: 0
}))

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    readFileSync: ((path: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
      if (state.countPrimaryReads && String(path) === state.primaryPath) state.primaryReads += 1
      return (fs.readFileSync as (...params: unknown[]) => unknown)(path, ...args)
    }) as typeof fs.readFileSync
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {}
  }))
}))

import { SessionManager } from '../src/main/session-manager'
import { Store, type PersistedSession } from '../src/main/store'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const root = join(process.cwd(), '.test-runtime', 'store-persist-performance')
let dir = ''

function storePath(): string {
  dir = join(root, randomUUID())
  mkdirSync(dir, { recursive: true })
  state.primaryPath = join(dir, 'store.json')
  return state.primaryPath
}

function session(id: string, label = id): PersistedSession {
  return {
    id,
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: dir,
    label,
    characterId: 'lion',
    agentSessionId: `agent-${id}`,
    createdAt: 1
  }
}

function resetCounters(): void {
  state.primaryReads = 0
  state.countPrimaryReads = false
  vi.mocked(fsyncSync).mockClear()
}

function lastPromptAt(path: string): number | undefined {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return parsed.sessions?.[0]?.lastPromptAt
}

function externallyRewritePrimary(path: string, label: string): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  parsed.sessions = [session(`external-${label}`, label)]
  actualFs.writeFileSync(path, JSON.stringify(parsed))
  const future = new Date(Date.now() + 5000)
  actualFs.utimesSync(path, future, future)
}

beforeEach(() => {
  vi.useFakeTimers()
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  resetCounters()
  vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
  state.primaryPath = ''
  state.countPrimaryReads = false
  state.primaryReads = 0
})

describe('store persist performance invariants', () => {
  it('writes compact JSON that still round-trips through the loader', () => {
    const path = storePath()
    const store = new Store(path)

    store.saveSessions([session('a', 'Slide Forge')])

    const contents = readFileSync(path, 'utf8')
    expect(contents).not.toContain('\n')
    expect(JSON.parse(contents).sessions[0].label).toBe('Slide Forge')
    expect(new Store(path).getSessions()[0].label).toBe('Slide Forge')
  })

  it('rotates the prior serialized store into .bak without re-reading the primary file', () => {
    const path = storePath()
    const store = new Store(path)
    store.saveSessions([session('a', 'First roster')])
    resetCounters()

    state.countPrimaryReads = true
    store.saveSessions([session('b', 'Second roster')])
    state.countPrimaryReads = false

    expect(state.primaryReads).toBe(0)
    expect(existsSync(`${path}.bak`)).toBe(true)
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions[0].label).toBe('First roster')
  })

  it('recovers from an external primary edit and rotates that on-disk content into .bak', () => {
    const path = storePath()
    const store = new Store(path)
    store.saveSessions([session('a', 'First roster')])
    externallyRewritePrimary(path, 'External roster')

    store.saveSessions([session('b', 'Second roster')])

    expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0].label).toBe('Second roster')
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions[0].label).toBe('External roster')
  })

  it('does not get stuck after recovering from an external primary edit', () => {
    const path = storePath()
    const store = new Store(path)
    store.saveSessions([session('a', 'First roster')])
    externallyRewritePrimary(path, 'External roster')

    store.saveSessions([session('b', 'Second roster')])
    store.saveSessions([session('c', 'Third roster')])

    expect(JSON.parse(readFileSync(path, 'utf8')).sessions[0].label).toBe('Third roster')
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions[0].label).toBe('Second roster')
  })
})

describe('session metadata persistence durability choices', () => {
  it('debounces routine metadata flushes for about 2 seconds and skips fsync', async () => {
    const path = storePath()
    const store = new Store(path)
    const manager = new SessionManager(store)
    const created = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    const beforePrompt = lastPromptAt(path)
    resetCounters()

    await vi.advanceTimersByTimeAsync(1)
    manager.input(created.id, '\r')
    await vi.advanceTimersByTimeAsync(1999)
    expect(lastPromptAt(path)).toBe(beforePrompt)

    await vi.advanceTimersByTimeAsync(1)
    expect(lastPromptAt(path)).toBeTypeOf('number')
    expect(lastPromptAt(path)).not.toBe(beforePrompt)
    expect(vi.mocked(fsyncSync)).not.toHaveBeenCalled()

    manager.disposeAll()
  })

  it('forces a durable fsync write of pending session metadata during shutdown', () => {
    const path = storePath()
    const store = new Store(path)
    const manager = new SessionManager(store)
    const created = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    resetCounters()

    manager.input(created.id, '\r')
    manager.disposeAll()

    expect(lastPromptAt(path)).toBeTypeOf('number')
    expect(vi.mocked(fsyncSync).mock.calls.length).toBeGreaterThan(0)
  })

  it('forces a durable shutdown flush after an external primary edit', () => {
    const path = storePath()
    const store = new Store(path)
    const manager = new SessionManager(store)
    const created = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    externallyRewritePrimary(path, 'External roster')

    manager.input(created.id, '\r')
    manager.disposeAll()

    expect(lastPromptAt(path)).toBeTypeOf('number')
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions[0].label).toBe('External roster')
    expect(vi.mocked(fsyncSync).mock.calls.length).toBeGreaterThan(0)
  })
})
