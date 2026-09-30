// Enforcing conductor-membership.ts's exclusivity rule at Store.saveSessions
// — the single choke point every session-membership mutation in
// session-manager.ts (setWorkspaceIds/addToWorkspace/moveToWorkspace/…)
// flows through via persistSessions(). Enforcing it here, once, is what
// makes it impossible for a session to end up conducted-double-booked no
// matter which of those call sites let it happen.
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type PersistedSession } from '../src/main/store'
import type { ConductorConfig } from '../src/shared/conductor'
import type { Workspace } from '../src/shared/types'

const temporaryDirs: string[] = []
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-store-membership-'))
  temporaryDirs.push(dir)
  return join(dir, 'store.json')
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace(id: string, order: number): Workspace {
  return { id, name: id, order, createdAt: 0 }
}

function config(workspaceId: string): ConductorConfig {
  return {
    workspaceId,
    repo: '/repo',
    integrationBranch: 'crew/integration',
    integrationWorktree: '/repo/.crew/integration',
    lanesDir: '/repo/.crew/lanes',
    maxLanes: 3,
    test: null
  }
}

function session(id: string, workspaceIds: string[]): PersistedSession {
  return {
    id, presetId: null, command: 'bash', args: [], cwd: '/', label: id,
    characterId: 'char-1', workspaceIds
  }
}

describe('Store — membership exclusivity on save', () => {
  it('leaves an ordinary (non-conducted) multi-workspace session untouched', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])

    store.saveSessions([session('s1', ['a', 'b'])])
    expect(store.getSessions()).toEqual([session('s1', ['a', 'b'])])
  })

  it('strips every conducted workspace after the first from a session that would join two', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a'), config('b')])

    store.saveSessions([session('s1', ['a', 'b'])])
    const [saved] = store.getSessions()
    expect(saved.workspaceIds).toEqual(['a'])
  })

  it('keeps a non-conducted workspace alongside the one conducted workspace kept', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1), workspace('c', 2)])
    store.saveConductorConfigs([config('a'), config('b')])

    store.saveSessions([session('s1', ['c', 'a', 'b'])])
    const [saved] = store.getSessions()
    expect(saved.workspaceIds).toEqual(['c', 'a'])
  })

  it('is a no-op when only one of the session workspaces is conducted', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a')])

    store.saveSessions([session('s1', ['a', 'b'])])
    expect(store.getSessions()[0].workspaceIds).toEqual(['a', 'b'])
  })

  it('enforces each session independently within the same save', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a'), config('b')])

    store.saveSessions([session('s1', ['a', 'b']), session('s2', ['b'])])
    expect(store.getSessions().map((s) => s.workspaceIds)).toEqual([['a'], ['b']])
  })

  it('never crashes on a workspace id that no longer exists, and round-trips it unchanged rather than dropping it', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0)])

    // 'ghost' names no real workspace (e.g. deleted concurrently) — the
    // enforcement pass must survive that instead of blowing up the whole
    // save, per Store's own fail-closed-but-never-crash posture. But
    // saveSessions is a hot path used by the whole app, not only conductor:
    // an id it doesn't recognise is not necessarily wrong, just unknown to
    // THIS enforcement pass, so it must be preserved exactly as given, not
    // silently discarded as if it were the thing being enforced against.
    store.saveSessions([session('s1', ['a', 'ghost'])])
    expect(store.getSessions()[0].workspaceIds).toEqual(['a', 'ghost'])
  })

  it('preserves an unknown workspace id even on a session that also has a real two-conducted-workspace conflict', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a'), config('b')])

    // 'ghost' must survive untouched while the genuine conflict between the
    // two conducted workspaces is still clamped — the two failure modes
    // (unknown id vs. real exclusivity violation) must not be conflated.
    store.saveSessions([session('s1', ['a', 'b', 'ghost'])])
    expect(store.getSessions()[0].workspaceIds).toEqual(['a', 'ghost'])
  })

  it('persists the clamped membership, not the originally-requested one', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a'), config('b')])
    store.saveSessions([session('s1', ['a', 'b'])])

    const reloaded = new Store(path)
    expect(reloaded.getSessions()[0].workspaceIds).toEqual(['a'])
  })
})

// Review finding 5. This ships to EVERY user, conducted or not:
// enforceMembershipExclusivity ran on every saveSessions(), and the
// membership graph it validated throws MalformedMembershipError on data
// the app really does produce — SessionManager.create()/restore() never
// de-duplicate workspaceIds, and the 2026-08-workspaces-firstclass
// migration can map two case-variant set names onto one id. A duplicate
// membership then made saving the session list throw.
describe('Store — saveSessions never throws because of conductor membership', () => {
  it('saves a session whose workspaceIds contain a duplicate, with no conducted workspace at all', () => {
    const store = new Store(tmpStorePath())
    store.saveWorkspaces([workspace('a', 0)])
    expect(store.getConductorConfigs()).toEqual([])

    const duplicated = session('s1', ['a', 'a'])
    expect(() => store.saveSessions([duplicated])).not.toThrow()
    // Unchanged: with nothing conducted there is no exclusivity rule to
    // apply, so this function has no business rewriting the list at all.
    expect(store.getSessions()).toEqual([duplicated])
  })

  it('still enforces exclusivity, without throwing, when the duplicate is on a conducted workspace', () => {
    const store = new Store(tmpStorePath())
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a'), config('b')])

    expect(() => store.saveSessions([session('s1', ['a', 'a', 'b'])])).not.toThrow()
    // 'a' twice is still one membership, so 'b' — the second conducted
    // workspace — is what gets clamped off. The duplicate itself is left
    // exactly as the caller wrote it: de-duplication happens only for the
    // validation graph, because rewriting a user's membership list beyond
    // the exclusivity rule is not this function's business.
    expect(store.getSessions()[0].workspaceIds).toEqual(['a', 'a'])
  })

  it('saves the list unchanged rather than throwing when the session ids themselves are duplicated', () => {
    const store = new Store(tmpStorePath())
    store.saveWorkspaces([workspace('a', 0), workspace('b', 1)])
    store.saveConductorConfigs([config('a')])

    const sessions = [session('s1', ['a', 'b']), { ...session('s1', ['a', 'b']), label: 'copy' }]
    expect(() => store.saveSessions(sessions)).not.toThrow()
    expect(store.getSessions()).toHaveLength(2)
  })
})
