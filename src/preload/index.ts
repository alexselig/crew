// Preload: the ONLY bridge between the sandboxed renderer and the main process.
// Exposes a typed, minimal `window.crew` surface — no raw ipcRenderer leaks.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type { CrewAPI, Unsubscribe } from '../shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CrewAPI = {
  createSession: (req) => ipcRenderer.invoke(IPC.SESSION_CREATE, req),
  closeSession: (id) => ipcRenderer.invoke(IPC.SESSION_CLOSE, id),
  restartSession: (id) => ipcRenderer.invoke(IPC.SESSION_RESTART, id),
  rename: (id, label) => ipcRenderer.invoke(IPC.SESSION_RENAME, { id, label }),
  setCharacter: (id, characterId) =>
    ipcRenderer.invoke(IPC.SESSION_SET_CHARACTER, { id, characterId }),
  setColor: (id, color) => ipcRenderer.invoke(IPC.SESSION_SET_COLOR, { id, color }),
  setTag: (id, tag) => ipcRenderer.invoke(IPC.SESSION_SET_TAG, { id, tag }),
  reorder: (orderedIds) => ipcRenderer.invoke(IPC.SESSION_REORDER, orderedIds),
  openWindow: () => ipcRenderer.invoke(IPC.WINDOW_OPEN),
  getRoster: () => ipcRenderer.invoke(IPC.ROSTER_GET),
  getPresets: () => ipcRenderer.invoke(IPC.PRESETS_GET),
  getCharacters: () => ipcRenderer.invoke(IPC.CHARACTERS_GET),
  getHomeDir: () => ipcRenderer.invoke(IPC.HOME_DIR_GET),
  detectAgents: () => ipcRenderer.invoke(IPC.AGENTS_DETECT),
  listSkills: (agent) => ipcRenderer.invoke(IPC.SKILLS_LIST, agent),
  getEvents: () => ipcRenderer.invoke(IPC.EVENTS_GET),
  listAssets: (id) => ipcRenderer.invoke(IPC.ASSETS_LIST, id),
  revealAsset: (path) => ipcRenderer.invoke(IPC.ASSET_REVEAL, path),
  openAsset: (path) => ipcRenderer.invoke(IPC.ASSET_OPEN, path),
  resolveAsset: (id, token) => ipcRenderer.invoke(IPC.ASSET_RESOLVE, { id, token }),
  searchTranscripts: (query) => ipcRenderer.invoke(IPC.TRANSCRIPT_SEARCH, query),
  getTranscript: (id) => ipcRenderer.invoke(IPC.TRANSCRIPT_GET, id),
  exportTranscript: (id, label) => ipcRenderer.invoke(IPC.TRANSCRIPT_EXPORT, { id, label }),
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
  getSets: () => ipcRenderer.invoke(IPC.SETS_GET),
  saveSet: (name) => ipcRenderer.invoke(IPC.SETS_SAVE, name),
  launchSet: (name) => ipcRenderer.invoke(IPC.SETS_LAUNCH, name),
  deleteSet: (name) => ipcRenderer.invoke(IPC.SETS_DELETE, name),

  sendInput: (id, data) => ipcRenderer.send(IPC.SESSION_INPUT, { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send(IPC.SESSION_RESIZE, { id, cols, rows }),

  pathForFile: (file) => webUtils.getPathForFile(file),

  onOutput: (cb) => subscribe(IPC.EVT_OUTPUT, cb),
  onState: (cb) => subscribe(IPC.EVT_STATE, cb),
  onRoster: (cb) => subscribe(IPC.EVT_ROSTER, cb),
  onJump: (cb) => subscribe(IPC.EVT_JUMP, cb),
  onNew: (cb) => subscribe(IPC.EVT_NEW, () => cb()),
  onAssets: (cb) => subscribe(IPC.EVT_ASSETS, cb)
}

contextBridge.exposeInMainWorld('crew', api)
