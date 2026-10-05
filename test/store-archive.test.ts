// The real session archive: a lifecycle with an exit, as opposed to the
// Workspace Manager's "archive", which only removes a session from every
// workspace and leaves it fully live (true of 88 of 131 real sessions).
//
// The load-bearing design choice under test here is that archived sessions
// live in their own list rather than behind a flag on `sessions`.
// persistSessions() rebuilds `sessions` from the live session map, so an
// archived session — which by definition is not live — would be silently
// dropped on the very next write if it shared that list.
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type PersistedSession } from '../src/main/store'

const temporaryDirs: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-store-archive-'))
  temporaryDirs.push(dir)
  return join(dir, 'store.json')
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function session(id: string, over: Partial<PersistedSession> = {}): PersistedSession {
  return {
    id,
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: '/Users/alex/crew',
    label: 'Session ' + id,
    characterId: 'c1',
    createdAt: 1000,
    lastPromptAt: 2000,
    ...over
  }
}

describe('the session archive', () => {
  it('starts empty', () => {
    const store = new Store(tmpStorePath())
    expect(store.archivedSessions).toEqual([])
  })

  it('keeps an archived session out of the live session list', () => {
    const store = new Store(tmpStorePath())
    store.saveSessions([session('a'), session('b')])
    store.archiveSessionRecord(session('b'))
    // The live list is owned by persistSessions and is rewritten wholesale;
    // archiving must not depend on that write to take effect.
    store.saveSessions([session('a')])
    expect(store.getSessions().map((s) => s.id)).toEqual(['a'])
    expect(store.archivedSessions.map((s) => s.id)).toEqual(['b'])
  })

  it('survives a rewrite of the live session list', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('b'))
    store.saveSessions([session('a')])
    store.saveSessions([session('a'), session('c')])
    expect(store.archivedSessions.map((s) => s.id)).toEqual(['b'])
  })

  it('stamps when the session was archived', () => {
    const store = new Store(tmpStorePath())
    const before = Date.now()
    store.archiveSessionRecord(session('a'))
    expect(store.archivedSessions[0]?.archivedAt).toBeGreaterThanOrEqual(before)
  })

  it('puts the most recently archived session first', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('a'))
    store.archiveSessionRecord(session('b'))
    expect(store.archivedSessions.map((s) => s.id)).toEqual(['b', 'a'])
  })

  it('never stores the same session twice', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('a'))
    store.archiveSessionRecord(session('a', { label: 'Renamed' }))
    expect(store.archivedSessions).toHaveLength(1)
    expect(store.archivedSessions[0]?.label).toBe('Renamed')
  })

  it('returns the session when it is taken back out, without the archive stamp', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('a', { label: 'Ship it' }))
    const back = store.unarchiveSessionRecord('a')
    expect(back?.label).toBe('Ship it')
    expect(back && 'archivedAt' in back).toBe(false)
    expect(store.archivedSessions).toEqual([])
  })

  it('preserves the conversation id so unarchiving can reattach', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('a', { agentSessionId: 'conv-1' }))
    expect(store.unarchiveSessionRecord('a')?.agentSessionId).toBe('conv-1')
  })

  it('returns null when taking out a session that is not archived', () => {
    const store = new Store(tmpStorePath())
    expect(store.unarchiveSessionRecord('nope')).toBeNull()
  })

  it('deletes an archived session for good', () => {
    const store = new Store(tmpStorePath())
    store.archiveSessionRecord(session('a'))
    expect(store.deleteArchivedSession('a')).toBe(true)
    expect(store.archivedSessions).toEqual([])
  })

  it('reports a delete that matched nothing', () => {
    const store = new Store(tmpStorePath())
    expect(store.deleteArchivedSession('nope')).toBe(false)
  })

  // The card's core claim: not "hidden from the list" but "never loaded at all".
  // restore() reads getSessions() and nothing else, so this is the real boundary.
  it('is invisible to getSessions, the list restore() rebuilds the roster from', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveSessions([session('a', { label: 'Keep' }), session('b', { label: 'Put away' })])
    store.archiveSessionRecord(session('b', { label: 'Put away' }))
    expect(store.getSessions().map((s) => s.label)).toEqual(['Keep'])

    const reopened = new Store(path)
    expect(reopened.getSessions().map((s) => s.label)).toEqual(['Keep'])
    expect(reopened.archivedSessions.map((s) => s.label)).toEqual(['Put away'])
  })

  it('persists the archive across a reload', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.archiveSessionRecord(session('a', { label: 'Old job' }))
    const reopened = new Store(path)
    expect(reopened.archivedSessions.map((s) => s.label)).toEqual(['Old job'])
  })

  it('writes the archive to disk under its own key', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.archiveSessionRecord(session('a'))
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.archivedSessions).toHaveLength(1)
    expect(raw.sessions ?? []).toHaveLength(0)
  })

  it('reads a store written before the archive existed', () => {
    const path = tmpStorePath()
    const seed = new Store(path)
    seed.saveSessions([session('a')])
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    delete raw.archivedSessions
    rmSync(path)
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(path, JSON.stringify(raw))
    const reopened = new Store(path)
    expect(reopened.archivedSessions).toEqual([])
    expect(reopened.getSessions().map((s) => s.id)).toEqual(['a'])
  })
})
