import { createRoot } from 'react-dom/client'
import '../styles.css'
import { App } from '../App'
import type { CrewAPI } from '../../shared/api'
import type { CharacterDef, CustomView, Preset, SessionInfo, Settings } from '../../shared/types'

const ROSTER_KEY = 'crew.e2e.customViews.roster'
const VIEWS_KEY = 'crew.e2e.customViews.views'
const COUNTER_KEY = 'crew.e2e.customViews.counter'

const noop = () => {}
const rosterListeners = new Set<(roster: SessionInfo[]) => void>()
const customViewListeners = new Set<(views: CustomView[]) => void>()

const defaultSettings: Settings = {
  notifications: false,
  sound: false,
  notifyOnlyWhenUnfocused: false,
  sortNeedsYouFirst: false,
  launchAtLogin: false,
  showSpend: true,
  showCredits: false,
  costMode: 'auto',
  aicPerUsd: 100,
  resumeConversations: true,
  contextMode: 'auto',
  budgetUsd: 0,
  inputTokenWarn: 100000,
  captureTranscripts: false,
  staleHideHours: 72,
  minimizedAsList: true,
  enhancedTerminal: false,
  showGithubButton: true,
  githubButtonOpensRepo: true
}

const presets: Preset[] = [
  { id: 'shell', name: 'Shell', command: '/bin/bash', args: [] },
  { id: 'copilot-cli', name: 'Copilot CLI', command: 'copilot', args: [] }
]

const characters: CharacterDef[] = [
  { id: 'fox', name: 'Fox', glyph: '🦊', color: '#ff7a3c' },
  { id: 'owl', name: 'Owl', glyph: '🦉', color: '#8a7bff' }
]

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function cloneSession(session: SessionInfo): SessionInfo {
  return { ...session, args: [...session.args], workspaceIds: [...(session.workspaceIds ?? [])] }
}

function cloneView(view: CustomView): CustomView {
  return {
    ...view,
    items: view.items.map((item) => ({ ...item }))
  }
}

function readRoster(): SessionInfo[] {
  return readJson<SessionInfo[]>(ROSTER_KEY, [])
}

function writeRoster(roster: SessionInfo[]): void {
  writeJson(ROSTER_KEY, roster)
  for (const listener of rosterListeners) listener(roster.map(cloneSession))
}

function readViews(): CustomView[] {
  return readJson<CustomView[]>(VIEWS_KEY, [])
}

function writeViews(views: CustomView[]): void {
  writeJson(VIEWS_KEY, views)
  for (const listener of customViewListeners) listener(views.map(cloneView))
}

function nextCounter(): number {
  const next = Number(localStorage.getItem(COUNTER_KEY) || '0') + 1
  localStorage.setItem(COUNTER_KEY, String(next))
  return next
}

const crew: CrewAPI = {
  createSession: async (req) => {
    const counter = nextCounter()
    const label = req.label?.trim() || `Session ${counter}`
    const now = Date.now() + counter
    const workspaceIds = [...(req.workspaceIds ?? [])]
    const session: SessionInfo = {
      id: `session-${counter}`,
      label,
      characterId: 'fox',
      color: '#ff7a3c',
      presetId: req.presetId,
      command: req.command,
      args: [...req.args],
      cwd: req.cwd,
      state: 'WORKING',
      status: 'active',
      pid: null,
      exitCode: null,
      costUsd: 0,
      creditsUsed: 0,
      autopilot: false,
      tag: '',
      workspaceIds,
      createdAt: now,
      stateChangedAt: now,
      lastPromptAt: now
    }
    const roster = [...readRoster(), session]
    writeRoster(roster)
    return cloneSession(session)
  },
  closeSession: async (id) => {
    writeRoster(readRoster().filter((session) => session.id !== id))
  },
  restartSession: async () => null,
  rename: async (id, label) => {
    writeRoster(readRoster().map((session) => (session.id === id ? { ...session, label } : session)))
  },
  setCharacter: async (id, characterId) => {
    writeRoster(
      readRoster().map((session) => (session.id === id ? { ...session, characterId } : session))
    )
  },
  setColor: async () => {},
  setTag: async () => {},
  setWorkspaces: async () => {},
  getWorkspaces: async () => [],
  createWorkspace: async () => null,
  renameWorkspace: async () => [],
  describeWorkspace: async () => [],
  deleteWorkspace: async () => [],
  reorderWorkspaces: async () => [],
  getCustomViews: async () => readViews().map(cloneView),
  createCustomView: async (input) => {
    const now = Date.now()
    const view: CustomView = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      mode: input.mode,
      items: input.items.map((item) => ({ ...item })),
      createdAt: now,
      updatedAt: now
    }
    const views = [...readViews(), view]
    writeViews(views)
    return {
      created: cloneView(view),
      views: views.map(cloneView)
    }
  },
  updateCustomView: async (id, input) => {
    const updatedAt = Date.now()
    const views = readViews().map((view) =>
      view.id === id
        ? {
            ...view,
            name: input.name.trim(),
            mode: input.mode,
            items: input.items.map((item) => ({ ...item })),
            updatedAt
          }
        : view
    )
    writeViews(views)
    return views.map(cloneView)
  },
  deleteCustomView: async (id) => {
    const views = readViews().filter((view) => view.id !== id)
    writeViews(views)
    return views.map(cloneView)
  },
  setSessionWorkspaces: async () => {},
  addSessionToWorkspace: async () => {},
  removeSessionFromWorkspace: async () => {},
  moveSessionWorkspace: async () => {},
  archiveSession: async () => {},
  duplicateSession: async () => {},
  setSessionDescription: async () => {},
  getAgents: async () => [],
  upsertAgent: async () => [],
  deleteAgent: async () => [],
  reorderAgents: async () => [],
  runAgent: async () => {
    throw new Error('not implemented in custom-view renderer integration fixture')
  },
  cancelAgentRun: async () => {},
  saveAgentResult: async () => ({ ok: false, error: 'not implemented' }),
  reorder: async () => {},
  openWindow: async () => {},
  getRoster: async () => readRoster().map(cloneSession),
  getPresets: async () => presets.map((preset) => ({ ...preset, args: [...preset.args] })),
  getCharacters: async () => characters.map((character) => ({ ...character })),
  getHomeDir: async () => '/tmp',
  detectAgents: async () => [],
  listCopilotModels: async () => ({ models: [], source: 'cli' }),
  listSkills: async () => [],
  getEvents: async () => [],
  listAssets: async () => [],
  revealAsset: async () => {},
  openAsset: async () => {},
  resolveAsset: async () => null,
  searchTranscripts: async () => [],
  getTranscript: async () => '',
  exportTranscript: async () => false,
  getAgentTranscript: async () => ({ version: '', blocks: [] }),
  scanTracker: async () => ({
    generatedAt: new Date(0).toISOString(),
    totals: { projects: 0, sessions: 0, repos: 0, found: 0, groups: 0, openTasks: 0, shippedWeek: 0 },
    groups: []
  }),
  getPastWeek: async () => ({
    available: false,
    weekStart: '',
    rangeLabel: '',
    stats: { sessions: 0, activeDays: 0, projects: 0, messages: 0, tokens: 0, topModel: null },
    days: [],
    projects: [],
    followups: []
  }),
  getUsageAnalytics: async () => ({
    available: false,
    generatedAt: 0,
    ranges: []
  }),
  checkForUpdate: async () => null,
  openExternal: async () => {},
  getGithubUrl: async () => null,
  getCommitActivity: async () => [],
  launchProject: async () => ({ ok: false, error: 'not implemented' }),
  stopProject: async () => ({ ok: false, error: 'not implemented' }),
  getRunningServers: async () => [],
  getSettings: async () => structuredClone(defaultSettings),
  updateSettings: async (patch) => ({ ...defaultSettings, ...patch }),
  getSets: async () => [],
  saveSet: async () => [],
  launchSet: async () => {},
  deleteSet: async () => [],
  sendInput: noop,
  wake: noop,
  resize: noop,
  pathForFile: () => '',
  getAppActivity: () => true,
  onOutput: () => noop,
  onState: () => noop,
  onRoster: (callback) => {
    rosterListeners.add(callback)
    return () => rosterListeners.delete(callback)
  },
  onJump: () => noop,
  onNew: () => noop,
  onWorkspace: () => noop,
  onWorkspaces: () => noop,
  onCustomViews: (callback) => {
    customViewListeners.add(callback)
    return () => customViewListeners.delete(callback)
  },
  onAppActivity: () => noop,
  onOpenWorkspaces: () => noop,
  onAgents: () => noop,
  onAgentRun: () => noop,
  onAssets: () => noop,
  onUpdate: () => noop
}

window.crew = crew

createRoot(document.getElementById('root')!).render(<App />)
