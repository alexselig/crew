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

  it('filters by workspace, status, and preset while preserving roster order', () => {
    const roster: SessionInfo[] = [
      { ...session('first'), workspaceIds: ['ws-1'] },
      { ...session('second'), presetId: null, workspaceIds: ['ws-1'] },
      { ...session('third'), presetId: 'other-preset', status: 'error', workspaceIds: ['ws-2'] },
      { ...session('fourth'), presetId: null, workspaceIds: ['ws-1', 'ws-2'] }
    ]

    expect(
      searchCustomViewSessions({
        sessions: roster,
        query: '',
        workspaces: [
          { id: 'ws-1', name: 'Workspace One', order: 0, createdAt: 1 },
          { id: 'ws-2', name: 'Workspace Two', order: 1, createdAt: 1 }
        ],
        presetNames: new Map([
          ['copilot-cli', 'Copilot CLI'],
          ['other-preset', 'Other Preset'],
          [null, 'No preset']
        ]),
        workspaceId: 'ws-1',
        status: 'active',
        presetId: 'copilot-cli'
      }).map((s) => s.id)
    ).toEqual(['first'])

    expect(
      searchCustomViewSessions({
        sessions: roster,
        query: '',
        workspaces: [
          { id: 'ws-1', name: 'Workspace One', order: 0, createdAt: 1 },
          { id: 'ws-2', name: 'Workspace Two', order: 1, createdAt: 1 }
        ],
        presetNames: new Map([
          ['copilot-cli', 'Copilot CLI'],
          ['other-preset', 'Other Preset'],
          [null, 'No preset']
        ]),
        workspaceId: 'ws-1',
        status: 'all',
        presetId: null
      }).map((s) => s.id)
    ).toEqual(['second', 'fourth'])

    expect(
      searchCustomViewSessions({
        sessions: roster,
        query: '',
        workspaces: [
          { id: 'ws-1', name: 'Workspace One', order: 0, createdAt: 1 },
          { id: 'ws-2', name: 'Workspace Two', order: 1, createdAt: 1 }
        ],
        presetNames: new Map([
          ['copilot-cli', 'Copilot CLI'],
          ['other-preset', 'Other Preset'],
          [null, 'No preset']
        ]),
        workspaceId: 'ws-1',
        status: 'all',
        presetId: 'all'
      }).map((s) => s.id)
    ).toEqual(['first', 'second', 'fourth'])

    expect(
      searchCustomViewSessions({
        sessions: roster,
        query: '',
        workspaces: [
          { id: 'ws-1', name: 'Workspace One', order: 0, createdAt: 1 },
          { id: 'ws-2', name: 'Workspace Two', order: 1, createdAt: 1 }
        ],
        presetNames: new Map([
          ['copilot-cli', 'Copilot CLI'],
          ['other-preset', 'Other Preset'],
          [null, 'No preset']
        ]),
        workspaceId: 'ws-1'
      }).map((s) => s.id)
    ).toEqual(['first', 'second', 'fourth'])
  })
})
