// Shared types & IPC contract used by main, preload, and renderer.

export type SessionState =
  | 'STARTING'
  | 'WORKING'
  | 'WAITING_INPUT'
  | 'WAITING_APPROVAL'
  | 'IDLE'
  | 'EXITED'
  | 'ERROR'

/** States where the agent is blocked on the human. */
export const NEEDS_YOU: SessionState[] = ['WAITING_INPUT', 'WAITING_APPROVAL']

export type SessionStatus = 'active' | 'exited' | 'error'

export interface Preset {
  id: string
  name: string
  command: string
  args: string[]
  /** Regex (source string) that, when matched against the tail of recent output, means "waiting for your prompt". */
  promptRegex?: string
  /** Regex (source string) for a yes/no / permission question. */
  approvalRegex?: string
  /** Keystrokes to send to approve a permission prompt (default "y\r"). */
  approveKeys?: string
  /** Keystrokes to send to deny a permission prompt (default "n\r"). */
  denyKeys?: string
  /** Silence (ms) after which the stream is considered no longer actively streaming. */
  quietMs?: number
  /**
   * Hysteresis: once a waiting condition holds, wait this long before committing
   * to WAITING_* so brief pauses between token bursts don't cause a flicker.
   */
  confirmMs?: number
  /** Suppress the low-confidence silence fallback for this long after your input. */
  inputGraceMs?: number
  /** Shown in New Session when the command isn't found on PATH. */
  installHint?: string
  /** Extra args appended when *resuming* this agent on startup (e.g. ['--continue']). */
  resumeArgs?: string[]
  /**
   * Regex (source string) whose first capture group is a cumulative USD amount
   * the agent prints (e.g. Claude Code's "Total cost: $0.42"). Latest/highest wins.
   */
  costRegex?: string
  /**
   * If set, promote an unrecognized quiet period to WAITING_INPUT after this many ms of silence.
   * Makes the red dot appear even without a tuned promptRegex. Set null to disable.
   */
  assumeWaitingAfterMs?: number | null
}

export interface CharacterDef {
  id: string
  name: string
  /** Emoji fallback glyph (MVP art). */
  glyph: string
  color: string
}

export interface Settings {
  notifications: boolean
  sound: boolean
  notifyOnlyWhenUnfocused: boolean
  sortNeedsYouFirst: boolean
  launchAtLogin: boolean
  showSpend: boolean
  showCredits: boolean
  resumeConversations: boolean
  /** Warn when total spend reaches this many USD (0 = off). */
  budgetUsd: number
  /** Opt-in: save each session's (ANSI-stripped) transcript locally for search/export. */
  captureTranscripts: boolean
}

export interface SessionInfo {
  id: string
  label: string
  characterId: string
  presetId: string | null
  command: string
  args: string[]
  cwd: string
  state: SessionState
  status: SessionStatus
  pid: number | null
  exitCode: number | null
  /** Human-readable explanation when status is 'error' (e.g. spawn failure). */
  errorMessage?: string
  /** Why the detector last changed state (for debugging/tooltips). */
  detectionReason?: string
  /** Latest dollar spend the agent has reported for this session ($0 if none). */
  costUsd: number
  /** Latest credit/usage count the agent has reported (e.g. Copilot AIC; 0 if none). */
  creditsUsed: number
  /** Optional user tag for grouping (e.g. a project name). */
  tag?: string
  createdAt: number
  stateChangedAt: number
}

export interface CreateSessionRequest {
  presetId: string | null
  command: string
  args: string[]
  cwd: string
  label?: string
  initialPrompt?: string
}

/** A saved "project set" of sessions that can be launched together. */
export interface SessionSet {
  name: string
  sessions: Array<{
    presetId: string | null
    command: string
    args: string[]
    cwd: string
    label: string
  }>
}

export interface OutputEvent {
  id: string
  data: string
}

/** IPC channel names. */
export const IPC = {
  // renderer -> main (invoke)
  SESSION_CREATE: 'session:create',
  SESSION_CLOSE: 'session:close',
  SESSION_RESTART: 'session:restart',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_RENAME: 'session:rename',
  SESSION_SET_CHARACTER: 'session:setCharacter',
  SESSION_SET_TAG: 'session:setTag',
  SESSION_REORDER: 'session:reorder',
  ROSTER_GET: 'roster:get',
  PRESETS_GET: 'presets:get',
  CHARACTERS_GET: 'characters:get',
  HOME_DIR_GET: 'home:get',
  AGENTS_DETECT: 'agents:detect',
  SKILLS_LIST: 'skills:list',
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETS_GET: 'sets:get',
  SETS_SAVE: 'sets:save',
  SETS_LAUNCH: 'sets:launch',
  SETS_DELETE: 'sets:delete',
  EVENTS_GET: 'events:get',
  TRANSCRIPT_SEARCH: 'transcript:search',
  TRANSCRIPT_GET: 'transcript:get',
  TRANSCRIPT_EXPORT: 'transcript:export',
  // main -> renderer (send)
  EVT_OUTPUT: 'evt:output',
  EVT_STATE: 'evt:state',
  EVT_ROSTER: 'evt:roster',
  EVT_JUMP: 'evt:jump',
  EVT_NEW: 'evt:new'
} as const
