import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, Store } from '../src/main/store'
import type { Agent, CustomView, SessionSet, Workspace } from '../src/shared/types'
import type { PersistedSession, WindowBounds } from '../src/main/store'

const temporaryDirs: string[] = []

function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-custom-views-'))
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
    cwd: `/tmp/${id}`,
    label,
    characterId: 'lion',
    color: '#ff7a3c',
    sets: ['Release'],
    workspaceIds: ['ws-1'],
    description: `${label} notes`,
    agentSessionId: `agent-${id}`,
    priorSessionId: `prior-${id}`,
    createdAt: 100,
    lastPromptAt: 101
  }
}

function workspace(): Workspace {
  return { id: 'ws-1', name: 'Release', order: 0, createdAt: 1 }
}

function set(): SessionSet {
  return { name: 'Release', sessions: [] }
}

function agent(): Agent {
  return {
    id: 'agent-1',
    name: 'Planner',
    icon: 'sparkles',
    color: '#123456',
    base: 'copilot-cli',
    persona: 'Plan carefully',
    contextMode: 'cwd',
    writes: false,
    order: 0
  }
}

function windowBounds(): WindowBounds {
  return { x: 1, y: 2, width: 1280, height: 720 }
}

function seed(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function readStore(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function expectUnrelatedFieldsUnchanged(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>
): void {
  const { customViews: _currentCustomViews, ...currentRest } = current
  const { customViews: _baselineCustomViews, ...baselineRest } = baseline
  expect(currentRest).toEqual(baselineRest)
}

function customView(id = 'view-1'): CustomView {
  return {
    id,
    name: 'Today',
    mode: 'curated-only',
    items: [{ sessionId: 's-1', labelSnapshot: 'Alpha' }],
    createdAt: 10,
    updatedAt: 10
  }
}

describe('custom view store persistence', () => {
  it('defaults getCustomViews to an empty list', () => {
    const path = tmpStorePath()

    expect(new Store(path).getCustomViews()).toEqual([])
  })

  it('persists create, update, and delete without mutating unrelated store data', () => {
    const path = tmpStorePath()
    seed(path, {
      characters: { 'copilot-cli::/tmp/s-1': { characterId: 'lion', lastLabel: 'Alpha' } },
      settings: { ...DEFAULT_SETTINGS, sound: true, budgetUsd: 25 },
      recentDirs: ['/tmp/s-1'],
      sessions: [session('s-1', 'Alpha'), session('s-2', 'Beta')],
      sets: [set()],
      workspaces: [workspace()],
      agents: [agent()],
      windowBounds: windowBounds(),
      migrations: [
        '2026-07-stale-hide-72h',
        '2026-08-workspaces-firstclass',
        '2026-08-context-mode-auto',
        '2026-08-agents-seed'
      ]
    })

    const store = new Store(path)
    const baseline = readStore(path)

    const created = store.createCustomView({
      name: '  Today  ',
      mode: 'curated-only',
      items: [
        { sessionId: 's-1', labelSnapshot: 'Alpha' },
        { sessionId: 's-1', labelSnapshot: 'Alpha duplicate' },
        { sessionId: 's-2', labelSnapshot: 'Beta' }
      ]
    })

    expect(created).toMatchObject({
      name: 'Today',
      mode: 'curated-only',
      items: [
        { sessionId: 's-1', labelSnapshot: 'Alpha' },
        { sessionId: 's-2', labelSnapshot: 'Beta' }
      ]
    })
    expect(created.id).toEqual(expect.any(String))
    expect(created.createdAt).toEqual(expect.any(Number))
    expect(created.updatedAt).toEqual(expect.any(Number))
    expect(created.updatedAt).toBe(created.createdAt)

    created.name = 'Mutated'
    created.items[0].labelSnapshot = 'Changed in caller'
    expect(store.getCustomViews()).toEqual([
      {
        id: expect.any(String),
        name: 'Today',
        mode: 'curated-only',
        groupBy: 'none',
        items: [
          { sessionId: 's-1', labelSnapshot: 'Alpha' },
          { sessionId: 's-2', labelSnapshot: 'Beta' }
        ],
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number)
      }
    ])

    const afterCreate = readStore(path)
    expect(afterCreate.customViews).toEqual([
      {
        id: created.id,
        name: 'Today',
        mode: 'curated-only',
        groupBy: 'none',
        items: [
          { sessionId: 's-1', labelSnapshot: 'Alpha' },
          { sessionId: 's-2', labelSnapshot: 'Beta' }
        ],
        createdAt: created.createdAt,
        updatedAt: created.updatedAt
      }
    ])
    expectUnrelatedFieldsUnchanged(afterCreate, baseline)

    const updated = store.updateCustomView(created.id, {
      name: 'Release',
      mode: 'ranked-plus-all',
      items: [
        { sessionId: 's-2', labelSnapshot: 'Beta' },
        { sessionId: 's-2', labelSnapshot: 'Beta duplicate' },
        { sessionId: 's-1', labelSnapshot: 'Alpha' }
      ]
    })

    expect(updated).toMatchObject({
      id: created.id,
      name: 'Release',
      mode: 'ranked-plus-all',
      items: [
        { sessionId: 's-2', labelSnapshot: 'Beta' },
        { sessionId: 's-1', labelSnapshot: 'Alpha' }
      ],
      createdAt: created.createdAt
    })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    const views = store.getCustomViews()
    views[0].items.push({ sessionId: 's-3', labelSnapshot: 'Caller only' })
    expect(store.getCustomViews()[0].items).toEqual([
      { sessionId: 's-2', labelSnapshot: 'Beta' },
      { sessionId: 's-1', labelSnapshot: 'Alpha' }
    ])

    const afterUpdate = readStore(path)
    expect(afterUpdate.customViews).toEqual([
      {
        id: created.id,
        name: 'Release',
        mode: 'ranked-plus-all',
        groupBy: 'none',
        items: [
          { sessionId: 's-2', labelSnapshot: 'Beta' },
          { sessionId: 's-1', labelSnapshot: 'Alpha' }
        ],
        createdAt: created.createdAt,
        updatedAt: updated.updatedAt
      }
    ])
    expectUnrelatedFieldsUnchanged(afterUpdate, baseline)

    const deleted = store.deleteCustomView(created.id)
    expect(deleted).toEqual([])
    const afterDelete = readStore(path)
    expect(afterDelete.customViews).toEqual([])
    expectUnrelatedFieldsUnchanged(afterDelete, baseline)
  })

  it('rejects duplicate names after trimming and case folding', () => {
    const path = tmpStorePath()
    const store = new Store(path)

    const first = store.createCustomView({
      name: 'Today',
      mode: 'curated-only',
      items: []
    })

    expect(() =>
      store.createCustomView({
        name: '  today  ',
        mode: 'curated-only',
        items: []
      })
    ).toThrow(/already exists/i)

    store.createCustomView({
      name: 'Release',
      mode: 'curated-only',
      items: []
    })

    expect(() =>
      store.updateCustomView(first.id, {
        name: ' release ',
        mode: 'ranked-plus-all',
        items: []
      })
    ).toThrow(/already exists/i)
  })

  it('rejects invalid modes, blank names, blank session ids, and unknown ids', () => {
    const path = tmpStorePath()
    const store = new Store(path)

    expect(() =>
      store.createCustomView({
        name: '   ',
        mode: 'curated-only',
        items: []
      })
    ).toThrow(/name/i)

    expect(() =>
      store.createCustomView({
        name: 'Today',
        mode: 'everything' as CustomView['mode'],
        items: []
      })
    ).toThrow(/mode/i)

    expect(() =>
      store.createCustomView({
        name: 'Today',
        mode: 'curated-only',
        items: [{ sessionId: '   ', labelSnapshot: 'Alpha' }]
      })
    ).toThrow(/session/i)

    expect(() =>
      store.updateCustomView('missing', {
        name: 'Today',
        mode: 'curated-only',
        items: []
      })
    ).toThrow(/not found/i)

    expect(() => store.deleteCustomView('missing')).toThrow(/not found/i)
  })

  it.each([
    [
      'non-array items',
      {
        name: 'Broken create',
        mode: 'curated-only',
        items: { sessionId: 's-1', labelSnapshot: 'Alpha' }
      },
      /items must be an array/i
    ],
    [
      'non-object items',
      {
        name: 'Broken create',
        mode: 'curated-only',
        items: ['s-1']
      },
      /items\[0\] must be an object/i
    ],
    [
      'non-string session ids',
      {
        name: 'Broken create',
        mode: 'curated-only',
        items: [{ sessionId: 12, labelSnapshot: 'Alpha' }]
      },
      /sessionId must be a non-empty string/i
    ],
    [
      'blank session ids',
      {
        name: 'Broken create',
        mode: 'curated-only',
        items: [{ sessionId: '   ', labelSnapshot: 'Alpha' }]
      },
      /sessionId must be a non-empty string/i
    ],
    [
      'non-string label snapshots',
      {
        name: 'Broken create',
        mode: 'curated-only',
        items: [{ sessionId: 's-1', labelSnapshot: 42 }]
      },
      /labelSnapshot must be a string/i
    ]
  ])('rejects %s on create without persisting partial data', (_label, input, message) => {
    const path = tmpStorePath()
    seed(path, {
      characters: { 'copilot-cli::/tmp/s-1': { characterId: 'lion', lastLabel: 'Alpha' } },
      settings: { ...DEFAULT_SETTINGS, sound: true },
      recentDirs: ['/tmp/s-1'],
      sessions: [session('s-1', 'Alpha')],
      sets: [set()],
      workspaces: [workspace()],
      customViews: [customView()],
      agents: [agent()],
      windowBounds: windowBounds(),
      migrations: [
        '2026-07-stale-hide-72h',
        '2026-08-workspaces-firstclass',
        '2026-08-context-mode-auto',
        '2026-08-agents-seed'
      ]
    })

    const store = new Store(path)
    const before = readStore(path)
    const beforeViews = store.getCustomViews()

    expect(() => store.createCustomView(input as Parameters<Store['createCustomView']>[0])).toThrow(message)
    expect(readStore(path)).toEqual(before)
    expect(store.getCustomViews()).toEqual(beforeViews)
    expectUnrelatedFieldsUnchanged(readStore(path), before)
  })

  it.each([
    [
      'non-array items',
      {
        name: 'Release',
        mode: 'ranked-plus-all',
        items: { sessionId: 's-1', labelSnapshot: 'Alpha' }
      },
      /items must be an array/i
    ],
    [
      'non-object items',
      {
        name: 'Release',
        mode: 'ranked-plus-all',
        items: ['s-1']
      },
      /items\[0\] must be an object/i
    ],
    [
      'non-string session ids',
      {
        name: 'Release',
        mode: 'ranked-plus-all',
        items: [{ sessionId: false, labelSnapshot: 'Alpha' }]
      },
      /sessionId must be a non-empty string/i
    ],
    [
      'blank session ids',
      {
        name: 'Release',
        mode: 'ranked-plus-all',
        items: [{ sessionId: ' ', labelSnapshot: 'Alpha' }]
      },
      /sessionId must be a non-empty string/i
    ],
    [
      'non-string label snapshots',
      {
        name: 'Release',
        mode: 'ranked-plus-all',
        items: [{ sessionId: 's-1', labelSnapshot: null }]
      },
      /labelSnapshot must be a string/i
    ]
  ])('rejects %s on update without persisting partial data', (_label, input, message) => {
    const path = tmpStorePath()
    seed(path, {
      characters: { 'copilot-cli::/tmp/s-1': { characterId: 'lion', lastLabel: 'Alpha' } },
      settings: { ...DEFAULT_SETTINGS, showCredits: true },
      recentDirs: ['/tmp/s-1'],
      sessions: [session('s-1', 'Alpha')],
      sets: [set()],
      workspaces: [workspace()],
      customViews: [customView()],
      agents: [agent()],
      windowBounds: windowBounds(),
      migrations: [
        '2026-07-stale-hide-72h',
        '2026-08-workspaces-firstclass',
        '2026-08-context-mode-auto',
        '2026-08-agents-seed'
      ]
    })

    const store = new Store(path)
    const before = readStore(path)
    const beforeViews = store.getCustomViews()

    expect(() => store.updateCustomView('view-1', input as Parameters<Store['updateCustomView']>[1])).toThrow(message)
    expect(readStore(path)).toEqual(before)
    expect(store.getCustomViews()).toEqual(beforeViews)
    expectUnrelatedFieldsUnchanged(readStore(path), before)
  })
})
