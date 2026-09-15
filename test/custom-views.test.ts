import { describe, expect, it } from 'vitest'
import {
  composeCustomView,
  moveIntoView,
  moveWithinView,
  removeFromView,
  searchCustomViewSessions
} from '../src/shared/custom-views'
import type { CustomView, SessionInfo } from '../src/shared/types'

const view = (mode: CustomView['mode'], ids: string[]): CustomView => ({
  id: 'view-1',
  name: 'Today',
  mode,
  items: ids.map((sessionId) => ({ sessionId, labelSnapshot: sessionId })),
  createdAt: 1,
  updatedAt: 1
})

const session = (id: string, lastPromptAt = 1): SessionInfo => ({
  id,
  label: `Session ${id}`,
  characterId: 'char',
  color: '#000000',
  presetId: 'copilot-cli',
  command: 'crew',
  args: [],
  cwd: `/work/${id}`,
  state: 'WORKING',
  status: 'active',
  pid: null,
  exitCode: null,
  costUsd: 0,
  creditsUsed: 0,
  autopilot: false,
  tag: `release-${id}`,
  workspaceIds: ['ws'],
  createdAt: lastPromptAt,
  stateChangedAt: lastPromptAt,
  lastPromptAt
})

describe('custom views', () => {
  it('composes curated-only in item order and reports missing entries', () => {
    const result = composeCustomView([session('b'), session('a')], view('curated-only', ['a', 'missing', 'b']))
    expect(result.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(result.missing.map((item) => item.sessionId)).toEqual(['missing'])
  })

  it('appends unranked sessions by recent activity', () => {
    const result = composeCustomView(
      [session('old', 10), session('ranked', 1), session('new', 20)],
      view('ranked-plus-all', ['ranked'])
    )
    expect(result.sessions.map((s) => s.id)).toEqual(['ranked', 'new', 'old'])
  })

  it('inserts, reorders, and removes without duplicates', () => {
    expect(moveIntoView(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    expect(moveIntoView(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveWithinView(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(removeFromView(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('searches all approved session fields', () => {
    const matches = [
      searchCustomViewSessions({
        sessions: [session('a')],
        query: 'Session a',
        workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
        presetNames: new Map([['copilot-cli', 'Copilot CLI']])
      }),
      searchCustomViewSessions({
        sessions: [session('a')],
        query: '/work/a',
        workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
        presetNames: new Map([['copilot-cli', 'Copilot CLI']])
      }),
      searchCustomViewSessions({
        sessions: [session('a')],
        query: 'release-a',
        workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
        presetNames: new Map([['copilot-cli', 'Copilot CLI']])
      }),
      searchCustomViewSessions({
        sessions: [session('a')],
        query: 'Release',
        workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
        presetNames: new Map([['copilot-cli', 'Copilot CLI']])
      }),
      searchCustomViewSessions({
        sessions: [session('a')],
        query: 'Copilot CLI',
        workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
        presetNames: new Map([['copilot-cli', 'Copilot CLI']])
      })
    ]

    for (const result of matches) {
      expect(result.map((s) => s.id)).toEqual(['a'])
    }
  })
})
