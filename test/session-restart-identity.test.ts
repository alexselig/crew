import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234, onData: () => {}, onExit: () => {},
    write: () => {}, resize: () => {}, kill: () => {}
  }))
}))

import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'

let dir: string
let store: Store
let manager: SessionManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-restart-'))
  store = new Store(join(dir, 'store.json'))
  manager = new SessionManager(store)
})

afterEach(() => {
  manager.disposeAll()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('restart preserves session identity', () => {
  it('keeps the id, agent conversation and workspace membership', () => {
    const created = manager.create({
      presetId: 'copilot-cli', command: 'copilot', args: [], cwd: dir, label: 'Ship-a-skill'
    })
    manager.setTag(created.id, 'SKILLS')
    manager.addToWorkspace(created.id, 'ws_iqs9qze6')
    manager.setDescription(created.id, 'a note')

    const before = manager.roster().find((s) => s.id === created.id)!
    expect(before.agentSessionId).toBeTruthy()

    const after = manager.restart(created.id)
    expect(after).not.toBeNull()

    // The conversation must survive: a fresh agentSessionId orphans the
    // transcript, which is what made a restarted session look destroyed.
    expect(after!.agentSessionId).toBe(before.agentSessionId)
    expect(after!.id).toBe(before.id)

    // Membership must survive, or the active workspace filter hides it.
    expect(after!.workspaceIds).toContain('ws_iqs9qze6')
    expect(after!.tag).toBe('SKILLS')
    expect(after!.description).toBe('a note')
    expect(after!.label).toBe('Ship-a-skill')
    expect(after!.createdAt).toBe(before.createdAt)

    // And it is still the only session in the roster, not a second copy.
    expect(manager.roster().filter((s) => s.label === 'Ship-a-skill')).toHaveLength(1)
  })
})
