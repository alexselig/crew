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
import type { AssetItem } from './assets'
import type { TrackerData, CommitActivity, RunningServer, LaunchResult } from './tracker'

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

/** A skill discovered on disk for a given agent (Copilot/Claude). */
export interface InstalledSkill {
  /** Stable id: `<source>:<name>` (used for favorites). */
  id: string
  /** Frontmatter `name:` — also the token typed as `use <name> to …`. */
  name: string
  description: string
  source: 'copilot' | 'claude'
}

export interface ActivityEvent {
  id: string
  ts: number
  from: SessionState
  to: SessionState
}

export interface AssetsEvent {
  id: string
  assets: AssetItem[]
}

export interface TranscriptMatch {
  sessionId: string
  lineNo: number
  line: string
}

export interface CrewAPI {
  // request/response
  createSession(req: CreateSessionRequest): Promise<SessionInfo>
  closeSession(id: string): Promise<void>
  restartSession(id: string): Promise<SessionInfo | null>
  rename(id: string, label: string): Promise<void>
  setCharacter(id: string, characterId: string): Promise<void>
  setColor(id: string, color: string): Promise<void>
  setTag(id: string, tag: string): Promise<void>
  /** Replace a session's workspace (named set) memberships. */
  setWorkspaces(id: string, sets: string[]): Promise<void>
  reorder(orderedIds: string[]): Promise<void>
  /** Open an additional app window (e.g. to use a second monitor). */
  openWindow(): Promise<void>
  getRoster(): Promise<SessionInfo[]>
  getPresets(): Promise<Preset[]>
  getCharacters(): Promise<CharacterDef[]>
  getHomeDir(): Promise<string>
  detectAgents(): Promise<AgentStatus[]>
  /** Skills installed on disk for the given agent command (e.g. "copilot", "claude"). */
  listSkills(agent: string): Promise<InstalledSkill[]>
  getEvents(): Promise<ActivityEvent[]>
  /** Recently created/changed previewable files in the session's cwd (newest first). */
  listAssets(id: string): Promise<AssetItem[]>
  /** Reveal an asset in Finder / the OS file manager. */
  revealAsset(path: string): Promise<void>
  /** Open an asset with the OS default app. */
  openAsset(path: string): Promise<void>
  /**
   * Resolve a path token printed in a session's output (absolute, ~/, or
   * relative to the session cwd). If it's a previewable file, it is added to
   * the session's asset list and returned; otherwise null.
   */
  resolveAsset(id: string, token: string): Promise<AssetItem | null>
  searchTranscripts(query: string): Promise<TranscriptMatch[]>
  getTranscript(id: string): Promise<string>
  exportTranscript(id: string, label: string): Promise<boolean>
  /** Live Project Tracker data for the working dirs of the open sessions. */
  scanTracker(): Promise<TrackerData>
  /** Open an external http(s) URL in the default browser. */
  openExternal(url: string): Promise<void>
  /** Recent git commits across the open sessions' working dirs (newest first). */
  getCommitActivity(): Promise<CommitActivity[]>
  /** Start (or adopt) a project's local dev server; returns its URL when ready. */
  launchProject(id: string): Promise<LaunchResult>
  /** Stop a dev server the tracker started (or untrack an adopted one). */
  stopProject(id: string): Promise<{ ok: boolean; external?: boolean; error?: string }>
  /** Currently-running dev servers started/adopted by the tracker. */
  getRunningServers(): Promise<RunningServer[]>
  getSettings(): Promise<Settings>
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  getSets(): Promise<SessionSet[]>
  saveSet(name: string): Promise<SessionSet[]>
  launchSet(name: string): Promise<void>
  deleteSet(name: string): Promise<SessionSet[]>

  // fire-and-forget (high-frequency)
  sendInput(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void

  // synchronous helpers
  /** Absolute filesystem path of a dropped/dragged File (Electron webUtils). */
  pathForFile(file: File): string

  // events (main -> renderer)
  onOutput(cb: (e: OutputEvent) => void): Unsubscribe
  onState(cb: (e: StateEvent) => void): Unsubscribe
  onRoster(cb: (roster: SessionInfo[]) => void): Unsubscribe
  onJump(cb: (id: string) => void): Unsubscribe
  onNew(cb: () => void): Unsubscribe
  /** Active workspace filter changed from the app menu (name, or null for All). */
  onWorkspace(cb: (name: string | null) => void): Unsubscribe
  onAssets(cb: (e: AssetsEvent) => void): Unsubscribe
}
