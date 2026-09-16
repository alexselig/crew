import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    fsyncSync: vi.fn(actual.fsyncSync)
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
  vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync)
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

function failTargetDirectorySyncOnce(path: string): void {
  let targetPublished = false
  let failed = false
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    actualFs.renameSync(source, target)
    if (target === path) targetPublished = true
  })
  vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
    const directory = actualFs.fstatSync(fd).isDirectory()
    if (directory && targetPublished) {
      targetPublished = false
      if (!failed) {
        failed = true
        throw new Error('store directory sync failed after publication')
      }
    }
    actualFs.fsyncSync(fd)
  })
}

const unixIt = process.platform === 'win32' ? it.skip : it

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

  unixIt('compensates a post-publication directory sync failure and stays rolled back on relaunch', () => {
    const path = join(dir, 'store.json')
    const errors = vi.fn()
    const store = new Store(path, errors)
    const existing = store.createCustomView({
      name: 'Existing',
      mode: 'curated-only',
      items: [{ sessionId: 'session-a', labelSnapshot: 'Session A' }]
    })
    const beforeDisk = fs.readFileSync(path, 'utf8')
    const beforeViews = store.getCustomViews()

    failTargetDirectorySyncOnce(path)

    expect(() =>
      store.updateCustomView(existing.id, {
        name: 'Updated',
        mode: 'ranked-plus-all',
        items: [{ sessionId: 'session-b', labelSnapshot: 'Session B' }]
      })
    ).toThrow('store directory sync failed after publication')

    expect(store.getCustomViews()).toEqual(beforeViews)
    expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
    expect(new Store(path).getCustomViews()).toEqual(beforeViews)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('mutation rolled back'))
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('changes remain in memory'))

    vi.mocked(fs.renameSync).mockClear()
    store.batchUpdates(() => {})
    expect(
      vi.mocked(fs.renameSync).mock.calls.filter(([, target]) => target === path)
    ).toHaveLength(0)
  })

  unixIt('restores a missing primary after the first strict create publishes but directory sync fails', () => {
    const path = join(dir, 'store.json')
    const errors = vi.fn()
    const store = new Store(path, errors)
    expect(fs.existsSync(path)).toBe(false)

    failTargetDirectorySyncOnce(path)

    expect(() =>
      store.createCustomView({
        name: 'First view',
        mode: 'curated-only',
        items: []
      })
    ).toThrow('store directory sync failed after publication')

    expect(store.getCustomViews()).toEqual([])
    expect(fs.existsSync(path)).toBe(false)
    expect(new Store(path).getCustomViews()).toEqual([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('mutation rolled back'))

    vi.mocked(fs.renameSync).mockClear()
    store.batchUpdates(() => {})
    expect(
      vi.mocked(fs.renameSync).mock.calls.filter(([, target]) => target === path)
    ).toHaveLength(0)
  })

  unixIt('preserves unrelated dirty memory and retries it without resurrecting a rolled-back view', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    const existing = store.createCustomView({
      name: 'Existing',
      mode: 'curated-only',
      items: []
    })
    const beforeDisk = fs.readFileSync(path, 'utf8')
    const denyTarget = vi.mocked(fs.renameSync).getMockImplementation()!
    let denied = false
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (!denied && target === path) {
        denied = true
        throw new Error('best-effort settings publication denied')
      }
      denyTarget(source, target)
    })
    store.updateSettings({ sound: true })
    expect(store.settings.sound).toBe(true)
    expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)

    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
    failTargetDirectorySyncOnce(path)

    expect(() =>
      store.updateCustomView(existing.id, {
        name: 'Updated',
        mode: 'ranked-plus-all',
        items: []
      })
    ).toThrow('store directory sync failed after publication')

    expect(store.settings.sound).toBe(true)
    expect(store.getCustomViews()).toEqual([existing])
    expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
    expect(new Store(path).settings.sound).toBe(false)
    expect(new Store(path).getCustomViews()).toEqual([existing])

    store.batchUpdates(() => {})
    const retried = new Store(path)
    expect(retried.settings.sound).toBe(true)
    expect(retried.getCustomViews()).toEqual([existing])
  })

  unixIt('rejects IPC and broadcasts nothing after a post-publication durability failure', async () => {
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
    failTargetDirectorySyncOnce(path)

    const handler = handlers.get(IPC.CUSTOM_VIEW_UPDATE)
    if (!handler) throw new Error('missing custom view update handler')
    await expect(
      Promise.resolve().then(() =>
        handler({} as IpcMainInvokeEvent, {
          id: existing.id,
          input: { name: 'Blocked', mode: 'ranked-plus-all', items: [] }
        })
      )
    ).rejects.toThrow('store directory sync failed after publication')

    expect(broadcast).not.toHaveBeenCalled()
    expect(store.getCustomViews()).toEqual(beforeViews)
    expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
    expect(new Store(path).getCustomViews()).toEqual(beforeViews)
  })

  it.each(['create', 'update', 'delete'] as const)(
    'rejects strict %s inside batchUpdates before changing Custom Views',
    (operation) => {
      const path = join(dir, 'store.json')
      const store = new Store(path)
      const existing = store.createCustomView({
        name: 'Existing',
        mode: 'curated-only',
        items: []
      })
      const beforeDisk = fs.readFileSync(path, 'utf8')
      const beforeViews = store.getCustomViews()
      const mutate = (): unknown => {
        if (operation === 'create') {
          return store.createCustomView({
            name: 'New view',
            mode: 'ranked-plus-all',
            items: []
          })
        }
        if (operation === 'update') {
          return store.updateCustomView(existing.id, {
            name: 'Updated',
            mode: 'ranked-plus-all',
            items: []
          })
        }
        return store.deleteCustomView(existing.id)
      }

      store.batchUpdates(() => {
        expect(mutate).toThrow('strict custom view mutations cannot run inside batchUpdates')
        expect(store.getCustomViews()).toEqual(beforeViews)
      })

      expect(store.getCustomViews()).toEqual(beforeViews)
      expect(fs.readFileSync(path, 'utf8')).toBe(beforeDisk)
    }
  )
})
