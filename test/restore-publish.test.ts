import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { published } = vi.hoisted(() => ({ published: vi.fn<(path: string) => void>() }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
      fs.renameSync(from, to)
      published(String(to))
    }
  }
})
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { Store } from '../src/main/store'
import { SessionManager } from '../src/main/session-manager'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  published.mockReset()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-restore-publish-'))
  dirs.push(dir)
  const path = join(dir, 'store.json')
  const store = new Store(path)
  store.saveSessions(Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`, agentSessionId: `agent-${i}`, presetId: 'copilot-cli',
    command: 'copilot', args: [], cwd: dir, label: `Session ${i}`, characterId: 'lion'
  })))
  const manager = new SessionManager(store)
  return { store, manager, path }
}

describe('atomic roster restoration', () => {
  it('publishes the full restored roster once, never a startup prefix', () => {
    const { manager, path } = fixture()
    const counts: number[] = []
    published.mockImplementation((target) => {
      if (target === path) counts.push(JSON.parse(readFileSync(path, 'utf8')).sessions.length)
    })
    try {
      expect(manager.restore()).toHaveLength(10)
      expect(counts).toEqual([10])
    } finally {
      manager.disposeAll()
    }
  })

  it('does not overwrite the saved roster if restore aborts halfway through', () => {
    const { manager, store, path } = fixture()
    const create = manager.create.bind(manager)
    let calls = 0
    vi.spyOn(manager, 'create').mockImplementation((...args) => {
      if (++calls === 2) throw new Error('Fixture interrupted restore')
      return create(...args)
    })
    expect(() => manager.restore()).toThrow('Fixture interrupted restore')
    manager.disposeAll()
    expect(store.getSessions()).toHaveLength(10)
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(10)
  })
})
