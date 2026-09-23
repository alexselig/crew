import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { CustomView } from '../src/shared/types'

const temporaryDirs: string[] = []

function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-view-groupby-'))
  temporaryDirs.push(dir)
  return join(dir, 'store.json')
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const readViews = (path: string): CustomView[] =>
  (JSON.parse(readFileSync(path, 'utf8')) as { customViews: CustomView[] }).customViews

describe('custom view groupBy', () => {
  it('defaults to "none" when the caller omits it', () => {
    const store = new Store(tmpStorePath())
    const created = store.createCustomView({ name: 'Today', mode: 'curated-only', items: [] })
    expect(created.groupBy).toBe('none')
  })

  it('persists a groupBy of "recent" across a reload', () => {
    const path = tmpStorePath()
    const created = new Store(path).createCustomView({
      name: 'Today',
      mode: 'ranked-plus-all',
      groupBy: 'recent',
      items: []
    })
    expect(created.groupBy).toBe('recent')
    expect(readViews(path)[0].groupBy).toBe('recent')
    // The reload is the part that matters: isCustomView() validates what comes
    // back off disk, so an unrecognised field would silently drop the view.
    expect(new Store(path).getCustomViews()[0].groupBy).toBe('recent')
  })

  it('round-trips a groupBy change through updateCustomView', () => {
    const path = tmpStorePath()
    const store = new Store(path)
    const created = store.createCustomView({ name: 'Today', mode: 'curated-only', items: [] })
    const updated = store.updateCustomView(created.id, {
      name: 'Today',
      mode: 'curated-only',
      groupBy: 'recent',
      items: []
    })
    expect(updated.groupBy).toBe('recent')
    expect(new Store(path).getCustomViews()[0].groupBy).toBe('recent')
  })

  it('loads a view stored before groupBy existed', () => {
    const path = tmpStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        customViews: [
          { id: 'v-1', name: 'Legacy', mode: 'curated-only', items: [], createdAt: 1, updatedAt: 1 }
        ]
      })
    )
    const views = new Store(path).getCustomViews()
    expect(views).toHaveLength(1)
    expect(views[0].name).toBe('Legacy')
    expect(views[0].groupBy).toBeUndefined()
  })

  it('rejects an unknown groupBy rather than storing it', () => {
    const store = new Store(tmpStorePath())
    expect(() =>
      store.createCustomView({
        name: 'Bad',
        mode: 'curated-only',
        groupBy: 'sideways' as never,
        items: []
      })
    ).toThrow(/groupBy/)
  })

  it('drops a persisted view whose groupBy is not a known value', () => {
    const path = tmpStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        customViews: [
          {
            id: 'v-1',
            name: 'Corrupt',
            mode: 'curated-only',
            groupBy: 'sideways',
            items: [],
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    expect(new Store(path).getCustomViews()).toEqual([])
  })
})
