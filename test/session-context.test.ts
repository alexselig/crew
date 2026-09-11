import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { spawn, write, briefPath, historySize } = vi.hoisted(() => ({
  write: vi.fn(),
  spawn: vi.fn(),
  briefPath: vi.fn(),
  historySize: { bytes: 0 }
}))
vi.mock('node-pty', () => ({ spawn }))
vi.mock('../src/main/handoff', async (original) => ({
  ...await original<typeof import('../src/main/handoff')>(),
  briefPathFor: briefPath
}))
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  statSync: vi.fn(() => ({ size: historySize.bytes }))
}))

import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'

let dir: string
let store: Store
let manager: SessionManager

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  historySize.bytes = 0
  briefPath.mockImplementation((id) => id === 'original' ? '/tmp/context brief.md' : null)
  spawn.mockReturnValue({
    pid: 1234, onData: () => {}, onExit: () => {},
    write, resize: () => {}, kill: () => {}
  })
  dir = mkdtempSync(join(tmpdir(), 'crew-context-'))
  store = new Store(join(dir, 'store.json'))
  manager = new SessionManager(store)
})

afterEach(() => {
  manager.disposeAll()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function saved(overrides = {}): void {
  store.saveSessions([{
    id: 'crew-id', agentSessionId: 'original', presetId: 'copilot-cli',
    command: 'copilot', args: ['--model', 'gpt-5.5'], cwd: dir,
    label: 'Test', characterId: 'lion', ...overrides
  }])
}

describe('automatic context loading', () => {
  it('submits a brief with the native startup flag exactly once on wake', () => {
    saved()
    store.updateSettings({ contextMode: 'brief' })
    const [restored] = manager.restore()
    expect(spawn).not.toHaveBeenCalled()
    manager.wake(restored.id)
    manager.wake(restored.id)
    const args: string[] = spawn.mock.calls[0][1]
    expect(args).toContain('--interactive')
    expect(args[args.indexOf('--interactive') + 1]).toContain('/tmp/context brief.md')
    expect(args).toContain(`--session-id=${restored.agentSessionId}`)
    expect(args).not.toContain('--continue')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(store.getSessions()[0].args).toEqual(['--model', 'gpt-5.5'])
    vi.advanceTimersByTime(10_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not inject an old brief into an existing native conversation', () => {
    saved({ agentSessionId: 'successor', priorSessionId: 'original' })
    historySize.bytes = 9_000_000
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
    expect(spawn.mock.calls[0][1]).toContain('--session-id=successor')
  })

  it('recovers a not-yet-started successor after another app restart', () => {
    saved({ agentSessionId: 'empty-successor', priorSessionId: 'original' })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).toContain('--interactive')
    expect(spawn.mock.calls[0][1]).toContain('--session-id=empty-successor')
  })

  it('keeps both IDs and explains recovery if a pending successor has lost its brief', () => {
    saved({ agentSessionId: 'empty-successor', priorSessionId: 'original' })
    briefPath.mockReturnValue(null)
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.roster()[0].errorMessage).toContain('copilot --resume=original')
    expect(store.getSessions()[0]).toMatchObject({ agentSessionId: 'empty-successor', priorSessionId: 'original' })
  })

  it('honors explicit Transcript mode for a pending brief successor', () => {
    saved({ agentSessionId: 'empty-successor', priorSessionId: 'original' })
    store.updateSettings({ contextMode: 'transcript' })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).toContain('--session-id=empty-successor')
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
  })

  it('reports a brief disappearing after restore rather than launching blank context', () => {
    saved()
    store.updateSettings({ contextMode: 'brief' })
    const [restored] = manager.restore()
    briefPath.mockReturnValue(null)
    manager.wake(restored.id)
    expect(spawn).not.toHaveBeenCalled()
    expect(manager.roster()[0].state).toBe('ERROR')
    expect(manager.roster()[0].errorMessage).toContain('brief is missing')
  })

  it('respects disabled context restore', () => {
    saved()
    store.updateSettings({ resumeConversations: false })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
    expect(restored.priorSessionId).toBe('original')
  })

  it('never sends Copilot briefs to shells or other providers', () => {
    saved({ presetId: 'shell', command: '/bin/sh', priorSessionId: 'original' })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
    vi.advanceTimersByTime(10_000)
    expect(write).not.toHaveBeenCalled()
  })

  it('loads an initial Copilot prompt through CLI startup instead of a timer', () => {
    manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir, initialPrompt: 'one\ntwo' })
    const args: string[] = spawn.mock.calls[0][1]
    expect(args.slice(-2)).toEqual(['--interactive', 'one\ntwo'])
    vi.advanceTimersByTime(2_000)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('creation model defaults', () => {
  it('defaults new Copilot sessions to Astra and persists the choice', () => {
    const created = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    expect(created.args).toEqual(['--model', 'gpt-6-astra'])
    expect(store.getSessions()[0].args).toEqual(created.args)
  })

  it('preserves explicit selections and existing CLI-default sessions on restore', () => {
    saved({ args: [] })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).not.toContain('--model')
    const created = manager.create({
      presetId: 'copilot-cli', command: 'copilot', args: ['--model=auto'], cwd: dir
    })
    expect(created.args).toEqual(['--model=auto'])
  })

  it('preserves the chosen model when duplicating a session', () => {
    const created = manager.create({
      presetId: 'copilot-cli', command: 'copilot', args: ['--model', 'gpt-5.5'], cwd: dir
    })
    expect(manager.duplicateSession(created.id, null)?.args).toEqual(['--model', 'gpt-5.5'])
  })
})
