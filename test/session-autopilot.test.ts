import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { onExit } = vi.hoisted(() => ({
  onExit: vi.fn<(callback: (event: { exitCode: number; signal?: number }) => void) => void>()
}))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234, onData: () => {}, onExit,
    write: () => {}, resize: () => {}, kill: () => {}
  }))
}))

import { CopilotAutopilotWatcher } from '../src/main/autopilot'
import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'

let dir: string
let store: Store
let manager: SessionManager

beforeEach(() => {
  vi.useFakeTimers()
  onExit.mockClear()
  dir = mkdtempSync(join(tmpdir(), 'crew-mode-'))
  store = new Store(join(dir, 'store.json'))
  manager = new SessionManager(store)
})

afterEach(() => {
  manager.disposeAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('autopilot roster updates', () => {
  it('publishes resolved on/off state to every roster subscriber', async () => {
    const read = vi.spyOn(CopilotAutopilotWatcher.prototype, 'isAutopilot').mockResolvedValue(true)
    const session = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    const roster = vi.fn()
    manager.on('roster', roster)
    await vi.advanceTimersByTimeAsync(1250)
    expect(manager.roster()[0].autopilot).toBe(true)
    expect(roster).toHaveBeenCalledWith([expect.objectContaining({ id: session.id, autopilot: true })])
    read.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(manager.roster()[0].autopilot).toBe(false)
    expect(roster).toHaveBeenLastCalledWith([expect.objectContaining({ id: session.id, autopilot: false })])
  })

  it('does not start overlapping reads or publish results for closed sessions', async () => {
    let resolve!: (on: boolean) => void
    const read = vi.spyOn(CopilotAutopilotWatcher.prototype, 'isAutopilot')
      .mockReturnValue(new Promise<boolean>((done) => { resolve = done }))
    const session = manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    await vi.advanceTimersByTimeAsync(3000)
    expect(read).toHaveBeenCalledTimes(1)
    manager.close(session.id)
    const roster = vi.fn()
    manager.on('roster', roster)
    resolve(true)
    await vi.advanceTimersByTimeAsync(1250)
    expect(manager.roster()).toEqual([])
    expect(roster).not.toHaveBeenCalled()
  })

  it('does not report historical autopilot for a sleeping process', async () => {
    const read = vi.spyOn(CopilotAutopilotWatcher.prototype, 'isAutopilot').mockResolvedValue(true)
    store.saveSessions([{
      id: 'sleeping', agentSessionId: 'prior', presetId: 'copilot-cli',
      command: 'copilot', args: [], cwd: dir, label: 'Sleeping', characterId: 'lion'
    }])
    manager.restore()
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).not.toHaveBeenCalled()
    expect(manager.roster()[0]).toMatchObject({ state: 'ASLEEP', autopilot: false })
  })

  it('clears the autopilot icon when its process exits', async () => {
    vi.spyOn(CopilotAutopilotWatcher.prototype, 'isAutopilot').mockResolvedValue(true)
    manager.create({ presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir })
    await vi.advanceTimersByTimeAsync(1250)
    expect(manager.roster()[0].autopilot).toBe(true)
    onExit.mock.calls[0][0]({ exitCode: 0 })
    expect(manager.roster()[0]).toMatchObject({ status: 'exited', autopilot: false })
  })
})
