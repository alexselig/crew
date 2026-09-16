import { createRoot } from 'react-dom/client'
import '../styles.css'
import { App } from '../App'

const ROSTER_KEY = 'crew.e2e.customViews.roster'
const VIEWS_KEY = 'crew.e2e.customViews.views'
const COUNTER_KEY = 'crew.e2e.customViews.counter'

const noop = () => {}
const rosterListeners = new Set<(roster: unknown[]) => void>()
const customViewListeners = new Set<(views: unknown[]) => void>()

const defaultSettings = {
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

const presets = [
  { id: 'shell', name: 'Shell', command: '/bin/bash', args: [] },
  { id: 'copilot-cli', name: 'Copilot CLI', command: 'copilot', args: [] }
]

const characters = [
  { id: 'fox', name: 'Fox', glyph: '🦊', color: '#ff7a3c' },
  { id: 'owl', name: 'Owl', glyph: '🦉', color: '#8a7bff' }
]

function readJson(key: string, fallback: unknown): any {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value))
}

function readRoster(): any[] {
  return readJson(ROSTER_KEY, [])
}

function writeRoster(roster: any[]): void {
  writeJson(ROSTER_KEY, roster)
  for (const listener of rosterListeners) listener(roster.map((session) => ({ ...session })))
}

function readViews(): any[] {
  return readJson(VIEWS_KEY, [])
}

function writeViews(views: any[]): void {
  writeJson(VIEWS_KEY, views)
  for (const listener of customViewListeners) listener(views.map((view) => structuredClone(view)))
}

function nextCounter(): number {
  const next = Number(localStorage.getItem(COUNTER_KEY) || '0') + 1
  localStorage.setItem(COUNTER_KEY, String(next))
  return next
}

Object.assign(window, {
  crew: {
    createSession: async (req: any) => {
      const counter = nextCounter()
      const now = Date.now() + counter
      const session = {
        id: `session-${counter}`,
        label: req.label || `Session ${counter}`,
        characterId: 'fox',
        color: '#ff7a3c',
        presetId: req.presetId,
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        state: 'WORKING',
        status: 'active',
        pid: null,
        exitCode: null,
        costUsd: 0,
        creditsUsed: 0,
        autopilot: false,
        tag: '',
        workspaceIds: req.workspaceIds ?? [],
        createdAt: now,
        stateChangedAt: now,
        lastPromptAt: now
      }
      const roster = [...readRoster(), session]
      writeRoster(roster)
      return structuredClone(session)
    },
    closeSession: async (id: string) => {
      writeRoster(readRoster().filter((session) => session.id !== id))
    },
    restartSession: async () => null,
    rename: async (id: string, label: string) => {
      writeRoster(
        readRoster().map((session) => (session.id === id ? { ...session, label } : session))
      )
    },
    setCharacter: async (id: string, characterId: string) => {
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
    getCustomViews: async () => readViews().map((view) => structuredClone(view)),
    createCustomView: async (input: any) => {
      const now = Date.now()
      const view = {
        id: crypto.randomUUID(),
        name: input.name.trim(),
        mode: input.mode,
        items: input.items.map((item: any) => ({ ...item })),
        createdAt: now,
        updatedAt: now
      }
      const views = [...readViews(), view]
      writeViews(views)
      return views.map((entry) => structuredClone(entry))
    },
    updateCustomView: async (id: string, input: any) => {
      const updatedAt = Date.now()
      const views = readViews().map((view) =>
        view.id === id
          ? {
              ...view,
              name: input.name.trim(),
              mode: input.mode,
              items: input.items.map((item: any) => ({ ...item })),
              updatedAt
            }
          : view
      )
      writeViews(views)
      return views.map((entry) => structuredClone(entry))
    },
    deleteCustomView: async (id: string) => {
      const views = readViews().filter((view) => view.id !== id)
      writeViews(views)
      return views.map((entry) => structuredClone(entry))
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
      throw new Error('not implemented in custom-view e2e fixture')
    },
    cancelAgentRun: async () => {},
    saveAgentResult: async () => ({ ok: false, error: 'not implemented' }),
    reorder: async () => {},
    openWindow: async () => {},
    getRoster: async () => readRoster().map((session) => structuredClone(session)),
    getPresets: async () => structuredClone(presets),
    getCharacters: async () => structuredClone(characters),
    getHomeDir: async () => '/tmp',
    detectAgents: async () => [],
    listCopilotModels: async () => ({ defaultModel: null, models: [] }),
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
    scanTracker: async () => ({ items: [] }),
    getPastWeek: async () => ({ summary: '', sections: [] }),
    getUsageAnalytics: async () => ({
      points: [],
      daily: [],
      summary: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalCost: 0
      }
    }),
    checkForUpdate: async () => null,
    openExternal: async () => {},
    getGithubUrl: async () => null,
    getCommitActivity: async () => [],
    launchProject: async () => ({ ok: false, error: 'not implemented' }),
    stopProject: async () => ({ ok: false, error: 'not implemented' }),
    getRunningServers: async () => [],
    getSettings: async () => structuredClone(defaultSettings),
    updateSettings: async (patch: Record<string, unknown>) => ({ ...defaultSettings, ...patch }),
    getSets: async () => [],
    saveSet: async () => [],
    launchSet: async () => {},
    deleteSet: async () => [],
    sendInput: noop,
    wake: noop,
    resize: noop,
    pathForFile: () => '',
    onOutput: () => noop,
    onState: () => noop,
    onRoster: (callback: (roster: unknown[]) => void) => {
      rosterListeners.add(callback)
      return () => rosterListeners.delete(callback)
    },
    onJump: () => noop,
    onNew: () => noop,
    onWorkspace: () => noop,
    onWorkspaces: () => noop,
    onCustomViews: (callback: (views: unknown[]) => void) => {
      customViewListeners.add(callback)
      return () => customViewListeners.delete(callback)
    },
    onOpenWorkspaces: () => noop,
    onAgents: () => noop,
    onAgentRun: () => noop,
    onAssets: () => noop,
    onUpdate: () => noop
  }
})

createRoot(document.getElementById('root')!).render(<App />)
