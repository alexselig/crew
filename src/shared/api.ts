// The typed surface exposed to the renderer via the preload contextBridge as
// `window.crew`. Kept in `shared` so both preload (implementation) and renderer
// (consumer) agree on the contract.

import type {
  SessionInfo,
  CreateSessionRequest,
  Preset,
  CharacterDef,
  SessionState,
  Settings,
  SessionSet
} from './types'

export interface StateEvent {
  id: string
  state: SessionState
  stateChangedAt: number
}

export interface OutputEvent {
  id: string
  data: string
}

/** Unsubscribe function returned by every event subscription. */
export type Unsubscribe = () => void

export interface AgentStatus {
  presetId: string
  name: string
  command: string
  available: boolean
  path: string | null
  installHint?: string
}

export interface ActivityEvent {
  id: string
  ts: number
  from: SessionState
  to: SessionState
}

export interface CrewAPI {
  // request/response
  createSession(req: CreateSessionRequest): Promise<SessionInfo>
  closeSession(id: string): Promise<void>
  restartSession(id: string): Promise<SessionInfo | null>
  rename(id: string, label: string): Promise<void>
  setCharacter(id: string, characterId: string): Promise<void>
  reorder(orderedIds: string[]): Promise<void>
  getRoster(): Promise<SessionInfo[]>
  getPresets(): Promise<Preset[]>
  getCharacters(): Promise<CharacterDef[]>
  getHomeDir(): Promise<string>
  detectAgents(): Promise<AgentStatus[]>
  getEvents(): Promise<ActivityEvent[]>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  getSets(): Promise<SessionSet[]>
  saveSet(name: string): Promise<SessionSet[]>
  launchSet(name: string): Promise<void>
  deleteSet(name: string): Promise<SessionSet[]>

  // fire-and-forget (high-frequency)
  sendInput(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void

  // events (main -> renderer)
  onOutput(cb: (e: OutputEvent) => void): Unsubscribe
  onState(cb: (e: StateEvent) => void): Unsubscribe
  onRoster(cb: (roster: SessionInfo[]) => void): Unsubscribe
  onJump(cb: (id: string) => void): Unsubscribe
  onNew(cb: () => void): Unsubscribe
}
