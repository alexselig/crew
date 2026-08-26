import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { PersistedSession } from '../src/main/store'

function tmpStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'crew-durability-')), 'store.json')
}

function session(id: string, label: string): PersistedSession {
  return {
    id,
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: '/Users/test',
    label,
    characterId: 'lion',
    color: '#ff7a3c',
    sets: [],
    workspaceIds: [],
    agentSessionId: `agent-${id}`,
    createdAt: 1,
    lastPromptAt: 1
  } as PersistedSession
}

describe('store durability — backup rotation', () => {
  it('keeps the previous roster in a .bak so one bad save is never the only copy', () => {
    const path = tmpStorePath()
    const store = new Store(path)

    store.saveSessions([session('a', 'Slide Forge'), session('b', 'Iron Wake')])
    // A later save that loses sessions (the failure mode we're guarding against).
    store.saveSessions([])

    expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(0)

    const bak = JSON.parse(readFileSync(`${path}.bak`, 'utf8'))
    expect(bak.sessions.map((s: PersistedSession) => s.label)).toEqual([
      'Slide Forge',
      'Iron Wake'
    ])
  })

  it('rotates .bak into .bak2 so two consecutive bad saves are still recoverable', () => {
    const path = tmpStorePath()
    const store = new Store(path)

    store.saveSessions([session('a', 'Slide Forge')])
    store.saveSessions([session('b', 'Iron Wake')])
    store.saveSessions([])

    expect(existsSync(`${path}.bak2`)).toBe(true)
    const bak2 = JSON.parse(readFileSync(`${path}.bak2`, 'utf8'))
    expect(bak2.sessions.map((s: PersistedSession) => s.label)).toEqual(['Slide Forge'])
  })
})

describe('store durability — recovery from a corrupt roster', () => {
  it('recovers the roster from .bak instead of starting empty', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveSessions([session('a', 'Slide Forge'), session('b', 'Iron Wake')])
    // Second save leaves a good .bak behind, then we truncate the live file the
    // way a crash mid-write would.
    store.saveSessions([session('a', 'Slide Forge'), session('b', 'Iron Wake')])
    writeFileSync(path, '{"sessions": [{"id":')

    const reopened = new Store(path)

    expect(reopened.getSessions().map((s) => s.label)).toEqual(['Slide Forge', 'Iron Wake'])
    // The unreadable file is preserved rather than silently discarded.
    expect(existsSync(path)).toBe(true)
  })

  it('still starts clean when there is no backup to fall back on', () => {
    const path = tmpStorePath()
    writeFileSync(path, 'not json at all')

    const store = new Store(path)

    expect(store.getSessions()).toEqual([])
  })
})
