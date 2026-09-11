import { afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { PersistedSession } from '../src/main/store'

const temporaryDirs: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-durability-'))
  temporaryDirs.push(dir)
  return join(dir, 'store.json')
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

  it('reports an irrecoverable store and disables saves instead of silently starting clean', () => {
    const path = tmpStorePath()
    writeFileSync(path, 'not json at all')

    const errors = vi.fn()
    const store = new Store(path, errors)

    expect(store.getSessions()).toEqual([])
    store.saveSessions([session('a', 'Unsaved')])
    expect(readFileSync(path, 'utf8')).toBe('not json at all')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('saving is disabled'))
  })
})

describe('store durability — dated snapshots', () => {
  it('snapshots the roster it loaded, so a later pruning save is still recoverable', () => {
    const path = tmpStorePath()
    const first = new Store(path)
    first.saveSessions([session('a', 'Slide Forge'), session('b', 'Iron Wake')])

    // A fresh launch snapshots what it found on disk...
    const second = new Store(path)
    // ...and then the roster is destroyed, taking .bak and .bak2 with it.
    second.saveSessions([])
    second.saveSessions([])
    second.saveSessions([])

    expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(0)
    expect(JSON.parse(readFileSync(`${path}.bak`, 'utf8')).sessions).toHaveLength(0)
    expect(JSON.parse(readFileSync(`${path}.bak2`, 'utf8')).sessions).toHaveLength(0)

    const snaps = second.listSnapshots()
    expect(snaps).toHaveLength(1)
    expect(snaps[0].sessions).toBe(2)
    const recovered = JSON.parse(readFileSync(snaps[0].file, 'utf8'))
    expect(recovered.sessions.map((s: PersistedSession) => s.label)).toEqual([
      'Slide Forge',
      'Iron Wake'
    ])
  })

  it('never spends a snapshot on an empty roster, which would record the damage', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    expect(store.listSnapshots()).toHaveLength(0)

    store.saveSessions([])
    expect(new Store(path).listSnapshots()).toHaveLength(0)

    store.saveSessions([session('a', 'Slide Forge')])
    expect(new Store(path).listSnapshots()).toHaveLength(1)
  })

  it('writes at most one snapshot per day however often Crew is relaunched', () => {
    const path = tmpStorePath()
    new Store(path).saveSessions([session('a', 'Slide Forge')])

    for (let i = 0; i < 5; i++) new Store(path)

    expect(new Store(path).listSnapshots()).toHaveLength(1)
  })

  it('keeps a bounded window of snapshots rather than growing without limit', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveSessions([session('a', 'Slide Forge')])

    // Backdate 20 days of history the way real launches would have left it.
    mkdirSync(store.snapshotDir, { recursive: true })
    for (let d = 1; d <= 20; d++) {
      const day = `2026-07-${String(d).padStart(2, '0')}`
      writeFileSync(
        join(store.snapshotDir, `crew-store-${day}.json`),
        JSON.stringify({ sessions: [session('a', 'Slide Forge')] })
      )
    }

    const reloaded = new Store(path)
    const kept = reloaded.listSnapshots()
    expect(kept).toHaveLength(14)
    // Pruning takes the oldest, so today's snapshot and the most recent days survive.
    expect(kept[0].day).toBe(new Date().toISOString().slice(0, 10))
    expect(kept.some((s) => s.day === '2026-07-20')).toBe(true)
    expect(kept.some((s) => s.day === '2026-07-01')).toBe(false)
  })
})
