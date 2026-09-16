import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync)
  }
})

import { Store } from '../src/main/store'
import { registerCustomViewIpc } from '../src/main/custom-view-ipc'
import { IPC } from '../src/shared/types'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let dir: string

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  dir = fs.mkdtempSync(join(tmpdir(), 'crew-custom-view-durability-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

function denyNextPublication(path: string): void {
  let denied = false
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (!denied && target === path) {
      denied = true
      throw new Error('custom view publication denied')
    }
    actualFs.renameSync(source, target)
  })
}

describe('custom view durable mutations', () => {
  it.each(['create', 'update', 'delete'] as const)(
    'rolls back %s when publishing the store fails',
    (operation) => {
      const path = join(dir, 'store.json')
      const store = new Store(path)
      const existing = store.createCustomView({
        name: 'Existing',
        mode: 'curated-only',
        items: [{ sessionId: 'session-a', labelSnapshot: 'Session A' }]
      })
      const beforeDisk = fs.readFileSync(path, 'utf8')
      const beforeViews = store.getCustomViews()

      denyNextPublication(path)

      const mutate = (): unknown => {
        if (operation === 'create') {
          return store.createCustomView({
            name: 'New view',
            mode: 'ranked-plus-all',
            items: [{ sessionId: 'session-b', labelSnapshot: 'Session B' }]
          })
        }
        if (operation === 'update') {
          return store.updateCustomView(existing.id, {
            name: 'Updated',
            mode: 'ranked-plus-all',
            items: [{ sessionId: 'session-b', labelSnapshot: 'Session B' }]
          })
        }
        return store.deleteCustomView(existing.id)
      }

      expect(mutate).toThrow('custom view publication denied')
      expect(store.getCustomViews()).toEqual(beforeViews)
      expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
    }
  )

  it('rejects IPC and broadcasts nothing when durable publication fails', async () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    const existing = store.createCustomView({
      name: 'Existing',
      mode: 'curated-only',
      items: []
    })
    const beforeDisk = fs.readFileSync(path, 'utf8')
    const beforeViews = store.getCustomViews()
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const broadcast = vi.fn()
    registerCustomViewIpc(
      {
        handle(channel, handler) {
          handlers.set(channel, handler)
        }
      },
      store,
      broadcast
    )
    denyNextPublication(path)

    const handler = handlers.get(IPC.CUSTOM_VIEW_UPDATE)
    if (!handler) throw new Error('missing custom view update handler')
    await expect(
      Promise.resolve().then(() =>
        handler({} as IpcMainInvokeEvent, {
          id: existing.id,
          input: { name: 'Blocked', mode: 'ranked-plus-all', items: [] }
        })
      )
    ).rejects.toThrow('custom view publication denied')

    expect(broadcast).not.toHaveBeenCalled()
    expect(store.getCustomViews()).toEqual(beforeViews)
    expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
  })
})
