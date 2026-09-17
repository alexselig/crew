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
    expect(spawn.mock.calls[0][1]).toContain('--session-id=original')
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
    expect(store.getSessions()[0].agentSessionId).toBe('original')
  })

  it('resumes the original transcript when context settings change before wake', () => {
    saved()
    store.updateSettings({ contextMode: 'brief' })
    const [restored] = manager.restore()
    expect(restored.agentSessionId).not.toBe('original')
    store.updateSettings({ contextMode: 'transcript' })
    manager.wake(restored.id)
    expect(spawn.mock.calls[0][1]).toContain('--session-id=original')
    expect(spawn.mock.calls[0][1]).not.toContain('--interactive')
    expect(store.getSessions()[0].agentSessionId).toBe('original')
  })

  it.each(['auto', 'transcript'] as const)('retains native continuation for an ID-less legacy %s restore', (contextMode) => {
    saved({ agentSessionId: undefined })
    store.updateSettings({ contextMode })
    const [restored] = manager.restore()
    manager.wake(restored.id)
    const args: string[] = spawn.mock.calls[0][1]
    expect(args).toContain('--continue')
    expect(args.some((arg) => arg.startsWith('--session-id'))).toBe(false)
    expect(store.getSessions()[0].agentSessionId).toBeUndefined()
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

  it('retries a failed context launch without discarding either recovery ID', () => {
    saved()
    store.updateSettings({ contextMode: 'brief' })
    const [restored] = manager.restore()
    briefPath.mockReturnValue(null)
    manager.wake(restored.id)
    expect(manager.roster()[0].status).toBe('error')
    briefPath.mockImplementation((id) => id === 'original' ? '/tmp/context brief.md' : null)
    const retried = manager.restart(restored.id)
    expect(retried).toMatchObject({ id: restored.id, agentSessionId: restored.agentSessionId, priorSessionId: 'original' })
    expect(retried?.errorMessage).toBeUndefined()
    expect(retried?.exitCode).toBeNull()
    expect(spawn.mock.calls[0][1]).toContain('--interactive')
    expect(spawn.mock.calls[0][1]).toContain(`--session-id=${restored.agentSessionId}`)
    expect(store.getSessions()[0]).toMatchObject({ agentSessionId: restored.agentSessionId, priorSessionId: 'original' })
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
  it('leaves new Copilot sessions on the CLI native default through final spawn args', () => {
    const created = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    expect(created.args).toEqual([])
    expect(store.getSessions()[0].args).toEqual(created.args)
    const launch: string[] = spawn.mock.calls[0][1]
    expect(launch.some((arg) => arg === '--model' || arg.startsWith('--model='))).toBe(false)
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
    expect(spawn.mock.calls.at(-1)?.[1]).toContain('--model=auto')
  })

  it('preserves the chosen model when duplicating a session', () => {
    const created = manager.create({
      presetId: 'copilot-cli', command: 'copilot', args: ['--model', 'gpt-5.5'], cwd: dir
    })
    expect(spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--model', 'gpt-5.5'])
    )
    expect(manager.duplicateSession(created.id, null)?.args).toEqual(['--model', 'gpt-5.5'])
  })

  it('does not overwrite a native /model choice with the original launch model', () => {
    saved({ args: ['--model=gpt-5.5', '--banner'] })
    historySize.bytes = 9000
    const [restored] = manager.restore()
    manager.wake(restored.id)
    const launch: string[] = spawn.mock.calls[0][1]
    expect(launch.some((arg) => arg === '--model' || arg.startsWith('--model='))).toBe(false)
    expect(launch).toContain('--banner')
    expect(store.getSessions()[0].args).toEqual(['--model=gpt-5.5', '--banner'])
  })
})
