import { describe, it, expect } from 'vitest'
import {
  canConduct,
  validateMembershipChange,
  MalformedMembershipError,
  type MembershipSession,
  type MembershipWorkspace
} from '../src/shared/conductor-membership'

const ws = (id: string, conducted = false): MembershipWorkspace => ({ id, name: id, conducted })
const s = (id: string, workspaceIds: string[]): MembershipSession => ({ id, label: id, workspaceIds })

describe('canConduct', () => {
  it('allows conducting a workspace whose sessions are in no other conducted workspace', () => {
    const result = canConduct([ws('a'), ws('b')], [s('s1', ['a']), s('s2', ['a', 'b'])], 'a')
    expect(result.ok).toBe(true)
  })

  it('rejects when a member session is already in a conducted workspace', () => {
    const result = canConduct([ws('a'), ws('b', true)], [s('s1', ['a', 'b'])], 'a')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]).toMatchObject({ sessionId: 's1', otherWorkspaceId: 'b' })
    }
  })

  it('names every conflicting session, not just the first', () => {
    const result = canConduct(
      [ws('a'), ws('b', true)],
      [s('s1', ['a', 'b']), s('s2', ['a', 'b']), s('s3', ['a'])],
      'a'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts.map((c) => c.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('ignores the workspace being tested when it is already conducted', () => {
    expect(canConduct([ws('a', true)], [s('s1', ['a'])], 'a').ok).toBe(true)
  })

  it('is unaffected by which workspace is active in which window', () => {
    // There is no active-workspace input by design: exclusivity is enforced on
    // membership data, never on a per-window view preference.
    const result = canConduct([ws('a'), ws('b', true)], [s('s1', ['b'])], 'a')
    expect(result.ok).toBe(true)
  })

  it('treats a session with no workspaces as no obstacle', () => {
    expect(canConduct([ws('a')], [s('s1', [])], 'a').ok).toBe(true)
  })

  it('fails closed on an unknown workspace id', () => {
    const result = canConduct([ws('a')], [s('s1', ['a'])], 'missing')
    expect(result.ok).toBe(false)
  })

  it('throws on an empty wsId rather than silently answering', () => {
    expect(() => canConduct([ws('a')], [], '')).toThrow(MalformedMembershipError)
  })

  it('throws on a duplicated workspace id instead of picking one arbitrarily', () => {
    expect(() => canConduct([ws('a'), ws('a', true)], [], 'a')).toThrow(MalformedMembershipError)
  })

  it('throws on a duplicated session id instead of merging their membership', () => {
    expect(() => canConduct([ws('a')], [s('s1', ['a']), s('s1', [])], 'a')).toThrow(
      MalformedMembershipError
    )
  })

  it('throws when a session names a workspace outside the given set', () => {
    expect(() => canConduct([ws('a')], [s('s1', ['a', 'ghost'])], 'a')).toThrow(
      MalformedMembershipError
    )
  })

  it('does not itself throw while building the error message for an exotic id', () => {
    // The id typed as `string` at compile time can still be an exotic runtime
    // value from an untyped caller; message construction must survive it.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() =>
      canConduct([{ id: cyclic as unknown as string, name: 'x' }], [], 'a')
    ).toThrow(MalformedMembershipError)
  })
})

describe('validateMembershipChange', () => {
  // Enforcement must cover EVERY membership mutation path, not only the toggle.
  it('rejects adding a session to a conducted workspace when it is in another', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', ['b'])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(false)
  })

  it('allows adding a session to a conducted workspace when it is in no other', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b')],
      [s('s1', ['b'])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(true)
  })

  it('always allows removing a session from a workspace', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', ['a'])],
      { sessionId: 's1', nextWorkspaceIds: [] }
    )
    expect(result.ok).toBe(true)
  })

  it('allows membership in many unconducted workspaces at once', () => {
    const result = validateMembershipChange(
      [ws('a'), ws('b'), ws('c')],
      [s('s1', [])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b', 'c'] }
    )
    expect(result.ok).toBe(true)
  })

  it('rejects membership in two conducted workspaces at once', () => {
    const result = validateMembershipChange(
      [ws('a', true), ws('b', true)],
      [s('s1', [])],
      { sessionId: 's1', nextWorkspaceIds: ['a', 'b'] }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts[0].sessionId).toBe('s1')
  })

  it('throws on an empty sessionId rather than silently answering', () => {
    expect(() =>
      validateMembershipChange([ws('a')], [], { sessionId: '', nextWorkspaceIds: ['a'] })
    ).toThrow(MalformedMembershipError)
  })

  it('throws when nextWorkspaceIds names a workspace outside the given set', () => {
    expect(() =>
      validateMembershipChange([ws('a')], [], { sessionId: 's1', nextWorkspaceIds: ['ghost'] })
    ).toThrow(MalformedMembershipError)
  })

  it('throws on a duplicated id within nextWorkspaceIds', () => {
    expect(() =>
      validateMembershipChange([ws('a')], [], { sessionId: 's1', nextWorkspaceIds: ['a', 'a'] })
    ).toThrow(MalformedMembershipError)
  })

  it('throws when the given membership graph itself is malformed', () => {
    expect(() =>
      validateMembershipChange([ws('a')], [s('s1', ['ghost'])], {
        sessionId: 's1',
        nextWorkspaceIds: ['a']
      })
    ).toThrow(MalformedMembershipError)
  })

  it('falls back to the sessionId as a label when the session does not yet exist', () => {
    const result = validateMembershipChange([ws('a', true), ws('b', true)], [], {
      sessionId: 'new-session',
      nextWorkspaceIds: ['a', 'b']
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflicts[0].sessionLabel).toBe('new-session')
  })
})
