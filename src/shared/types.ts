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
  /** Silence (ms) after which the stream is considered no longer actively streaming. */
  quietMs?: number
  /**
   * Hysteresis: once a waiting condition holds, wait this long before committing
   * to WAITING_* so brief pauses between token bursts don't cause a flicker.
   */
  confirmMs?: number
  /** Suppress the low-confidence silence fallback for this long after your input. */
  inputGraceMs?: number
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
  SESSION_REORDER: 'session:reorder',
  ROSTER_GET: 'roster:get',
  PRESETS_GET: 'presets:get',
  CHARACTERS_GET: 'characters:get',
  HOME_DIR_GET: 'home:get',
  // main -> renderer (send)
  EVT_OUTPUT: 'evt:output',
  EVT_STATE: 'evt:state',
  EVT_ROSTER: 'evt:roster',
  EVT_JUMP: 'evt:jump',
  EVT_NEW: 'evt:new'
} as const
