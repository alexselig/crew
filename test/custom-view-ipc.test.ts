import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { IPC, type CustomView } from '../src/shared/types'
import { registerCustomViewIpc, type CustomViewStore } from '../src/main/custom-view-ipc'

type Handler = Parameters<IpcMain['handle']>[1]

function harness(store: CustomViewStore) {
  const handlers = new Map<string, Handler>()
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
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler: ${channel}`)
    return Promise.resolve().then(() => handler({} as IpcMainInvokeEvent, ...args))
  }
  return { broadcast, handlers, invoke }
}

describe('custom view IPC runtime contract', () => {
  it('registers CRUD handlers that return and broadcast the committed list', async () => {
    const existing = {
      id: 'view-1',
      name: 'Existing',
      mode: 'curated-only' as const,
      items: [],
      createdAt: 1,
      updatedAt: 1
    }
    const created = { ...existing, id: 'view-2', name: 'Created' }
    const updated = { ...created, name: 'Updated', updatedAt: 2 }
    let views = [existing]
    const store: CustomViewStore = {
      getCustomViews: () => structuredClone(views),
      createCustomView: vi.fn(() => {
        views = [...views, created]
        return structuredClone(created)
      }),
      updateCustomView: vi.fn(() => {
        views = views.map((view) => view.id === updated.id ? updated : view)
        return structuredClone(updated)
      }),
      deleteCustomView: vi.fn(() => {
        views = views.filter((view) => view.id !== updated.id)
        return structuredClone(views)
      })
    }
    const { broadcast, handlers, invoke } = harness(store)

    expect([...handlers.keys()]).toEqual([
      IPC.CUSTOM_VIEWS_GET,
      IPC.CUSTOM_VIEW_CREATE,
      IPC.CUSTOM_VIEW_UPDATE,
      IPC.CUSTOM_VIEW_DELETE
    ])
    await expect(invoke(IPC.CUSTOM_VIEWS_GET)).resolves.toEqual([existing])
    await expect(
      invoke(IPC.CUSTOM_VIEW_CREATE, { name: 'Created', mode: 'curated-only', items: [] })
    ).resolves.toEqual({ created, views: [existing, created] })
    await expect(
      invoke(IPC.CUSTOM_VIEW_UPDATE, {
        id: created.id,
        input: { name: 'Updated', mode: 'curated-only', items: [] }
      })
    ).resolves.toEqual([existing, updated])
    await expect(invoke(IPC.CUSTOM_VIEW_DELETE, updated.id)).resolves.toEqual([existing])
    expect(broadcast.mock.calls).toEqual([
      [IPC.EVT_CUSTOM_VIEWS, [existing, created]],
      [IPC.EVT_CUSTOM_VIEWS, [existing, updated]],
      [IPC.EVT_CUSTOM_VIEWS, [existing]]
    ])
  })

  it("identifies each caller's own created view during concurrent window creation", async () => {
    let sequence = 0
    let views: CustomView[] = []
    const store: CustomViewStore = {
      getCustomViews: () => structuredClone(views),
      createCustomView: vi.fn((input) => {
        const created: CustomView = {
          id: `view-${++sequence}`,
          ...input,
          createdAt: sequence,
          updatedAt: sequence
        }
        views = [...views, created]
        return structuredClone(created)
      }),
      updateCustomView: vi.fn(),
      deleteCustomView: vi.fn()
    }
    const { invoke } = harness(store)

    const [windowA, windowB] = await Promise.all([
      invoke(IPC.CUSTOM_VIEW_CREATE, {
        name: 'Window A',
        mode: 'curated-only',
        items: []
      }),
      invoke(IPC.CUSTOM_VIEW_CREATE, {
        name: 'Window B',
        mode: 'curated-only',
        items: []
      })
    ])

    expect(windowA).toMatchObject({
      created: { id: 'view-1', name: 'Window A' }
    })
    expect(windowB).toMatchObject({
      created: { id: 'view-2', name: 'Window B' }
    })
    expect((windowB as { views: Array<{ id: string }> }).views.map((view) => view.id)).toEqual([
      'view-1',
      'view-2'
    ])
  })

  it('has the renderer select the authoritative created view instead of diffing stale ids', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onSaved={(saved) =>')
    expect(source).toContain("c.setPresentation({ kind: 'custom', viewId: saved.id })")
    expect(source).not.toContain('previousIds')
  })

  it('rejects a failed mutation without broadcasting success', async () => {
    const error = new Error('custom view publication denied')
    const store: CustomViewStore = {
      getCustomViews: () => [],
      createCustomView: () => {
        throw error
      },
      updateCustomView: () => {
        throw error
      },
      deleteCustomView: () => {
        throw error
      }
    }
    const { broadcast, invoke } = harness(store)

    await expect(
      invoke(IPC.CUSTOM_VIEW_CREATE, { name: 'Blocked', mode: 'curated-only', items: [] })
    ).rejects.toBe(error)
    await expect(
      invoke(IPC.CUSTOM_VIEW_UPDATE, {
        id: 'view-1',
        input: { name: 'Blocked', mode: 'curated-only', items: [] }
      })
    ).rejects.toBe(error)
    await expect(invoke(IPC.CUSTOM_VIEW_DELETE, 'view-1')).rejects.toBe(error)
    expect(broadcast).not.toHaveBeenCalled()
  })
})
