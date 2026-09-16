import { describe, expect, it } from 'vitest'
import { reduceOrganizer } from '../src/renderer/custom-view-dnd'
import type { CustomViewItem, SessionInfo } from '../src/shared/types'

const item = (sessionId: string, labelSnapshot = sessionId): CustomViewItem => ({
  sessionId,
  labelSnapshot
})

const session = (id: string, label = `Session ${id}`): SessionInfo => ({
  id,
  label,
  characterId: 'fox',
  color: '#ff7a3c',
  presetId: 'copilot-cli',
  command: 'copilot',
  args: [],
  cwd: `/work/${id}`,
  state: 'WORKING',
  status: 'active',
  pid: null,
  exitCode: null,
  costUsd: 0,
  creditsUsed: 0,
  autopilot: false,
  workspaceIds: [],
  createdAt: 1,
  stateChangedAt: 1,
  lastPromptAt: 1
})

function expectOrder(items: CustomViewItem[], ids: string[]): void {
  const actual = items.map((entry) => entry.sessionId)
  expect(actual).toEqual(ids)
  expect(new Set(actual).size).toBe(actual.length)
}

describe('custom view organizer reducer', () => {
  it('inserts a full session snapshot at the exact rank without duplicates', () => {
    const inserted = reduceOrganizer([item('a'), item('c')], {
      type: 'insert',
      session: session('b', 'Current B'),
      index: 1
    })
    expectOrder(inserted, ['a', 'b', 'c'])
    expect(inserted[1]).toEqual({ sessionId: 'b', labelSnapshot: 'Current B' })

    const moved = reduceOrganizer(inserted, {
      type: 'insert',
      session: session('a', 'Renamed A'),
      index: 2
    })
    expectOrder(moved, ['b', 'a', 'c'])
    expect(moved[1]).toEqual({ sessionId: 'a', labelSnapshot: 'Renamed A' })
  })

  it('moves a ranked session to the exact visual insertion slot', () => {
    const result = reduceOrganizer([item('a'), item('b'), item('c')], {
      type: 'move',
      sessionId: 'a',
      index: 2
    })
    expectOrder(result, ['b', 'a', 'c'])
  })

  it('removes only the requested ranked session', () => {
    const result = reduceOrganizer([item('a'), item('b'), item('c')], {
      type: 'remove',
      sessionId: 'b'
    })
    expectOrder(result, ['a', 'c'])
  })

  it('moves a ranked session one position up or down', () => {
    const up = reduceOrganizer([item('a'), item('b'), item('c')], {
      type: 'move-up',
      sessionId: 'b'
    })
    expectOrder(up, ['b', 'a', 'c'])

    const down = reduceOrganizer(up, {
      type: 'move-down',
      sessionId: 'b'
    })
    expectOrder(down, ['a', 'b', 'c'])
  })

  it('moves a ranked session to first or last', () => {
    const first = reduceOrganizer([item('a'), item('b'), item('c')], {
      type: 'move-first',
      sessionId: 'c'
    })
    expectOrder(first, ['c', 'a', 'b'])

    const last = reduceOrganizer(first, {
      type: 'move-last',
      sessionId: 'c'
    })
    expectOrder(last, ['a', 'b', 'c'])
  })

  it('clamps insertion slots and leaves missing or boundary moves unchanged', () => {
    const base = [item('a'), item('b')]
    expectOrder(
      reduceOrganizer(base, { type: 'insert', session: session('c'), index: -10 }),
      ['c', 'a', 'b']
    )
    expectOrder(
      reduceOrganizer(base, { type: 'insert', session: session('c'), index: 99 }),
      ['a', 'b', 'c']
    )
    expect(reduceOrganizer(base, { type: 'move', sessionId: 'missing', index: 0 })).toEqual(base)
    expect(reduceOrganizer(base, { type: 'move-up', sessionId: 'a' })).toEqual(base)
    expect(reduceOrganizer(base, { type: 'move-down', sessionId: 'b' })).toEqual(base)
  })
})
