import type { IpcMain } from 'electron'
import type { CustomView } from '../shared/types'
import { IPC } from '../shared/types'
import type { CustomViewInput } from '../shared/api'

export interface CustomViewStore {
  getCustomViews(): CustomView[]
  createCustomView(input: CustomViewInput): CustomView
  updateCustomView(id: string, input: CustomViewInput): CustomView
  deleteCustomView(id: string): CustomView[]
}

export function registerCustomViewIpc(
  ipc: Pick<IpcMain, 'handle'>,
  store: CustomViewStore,
  broadcast: (channel: string, payload: CustomView[]) => void
): void {
  const pushCustomViews = (): CustomView[] => {
    const list = store.getCustomViews()
    broadcast(IPC.EVT_CUSTOM_VIEWS, list)
    return list
  }

  ipc.handle(IPC.CUSTOM_VIEWS_GET, () => store.getCustomViews())
  ipc.handle(IPC.CUSTOM_VIEW_CREATE, (_event, input: CustomViewInput) => {
    const created = store.createCustomView(input)
    return { created, views: pushCustomViews() }
  })
  ipc.handle(
    IPC.CUSTOM_VIEW_UPDATE,
    (_event, payload: { id: string; input: CustomViewInput }) => {
      store.updateCustomView(payload.id, payload.input)
      return pushCustomViews()
    }
  )
  ipc.handle(IPC.CUSTOM_VIEW_DELETE, (_event, id: string) => {
    store.deleteCustomView(id)
    return pushCustomViews()
  })
}
