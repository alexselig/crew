// Pure, dependency-free session state detection engine.
//
// Because Crew owns the PTY, it sees the full raw output byte stream and knows
// exactly when it last sent input. "Waiting for you" is inferred from output
// quiescence + (optionally) a matched input-prompt signature, with debounce
// hysteresis so brief pauses between token bursts don't flip the red dot. This
// module is intentionally free of Electron/node-pty imports so it can be unit
// tested in plain Node.

import type { SessionState } from './types'

export type DetectionReason =
  | 'streaming'
  | 'spinner'
  | 'approval-prompt'
  | 'input-prompt'
  | 'silence'
  | 'idle'
  | 'none'

export interface DetectionConfig {
  /** Silence (ms) after which we consider the agent no longer actively streaming. */
  quietMs: number
  /**
   * Debounce: once a waiting condition first holds, require it to persist for
   * this long before committing to WAITING_* (prevents flicker mid-burst).
   */
  confirmMs: number
  /**
   * If set, promote an unrecognized quiet period to WAITING_INPUT after this many
   * ms of silence (only once the agent has produced output *since your last
   * input*). Set null to disable.
   */
  assumeWaitingAfterMs: number | null
  /**
   * After you send input, suppress the low-confidence silence fallback for this
   * long. Terminal echo of your keystrokes counts as "output", so without this a
   * silent think-time / tool stall right after your prompt would be misread as
   * "waiting for you". High-confidence prompt/approval matches are NOT suppressed.
   */
  inputGraceMs: number
  /** Matched against the tail of recent (ANSI-stripped) output → WAITING_INPUT. */
  promptRegex: RegExp | null
  /** Matched against the tail of recent output → WAITING_APPROVAL. */
  approvalRegex: RegExp | null
  /**
   * Recognizes "the agent is animating" glyphs (braille/block spinners, etc.).
   * Spinner frames are output, so they already keep us in WORKING; this is used
   * to annotate the reason and could inform future confidence scoring.
   */
  spinnerRegex: RegExp | null
}

// Braille-pattern spinners (⠋⠙⠹…), block/quadrant progress bars, and circle
// spinners cover the vast majority of CLI agent activity indicators.
export const DEFAULT_SPINNER_REGEX =
  /[\u2800-\u28FF\u2580-\u259F\u25E2-\u25E5◐◓◑◒◴◷◶◵]/

export const DEFAULT_DETECTION: DetectionConfig = {
  quietMs: 800,
  confirmMs: 0,
  assumeWaitingAfterMs: 1500,
  inputGraceMs: 2500,
  promptRegex: null,
  approvalRegex: null,
  spinnerRegex: DEFAULT_SPINNER_REGEX
}

const TERMINAL_STATES: SessionState[] = ['EXITED', 'ERROR']

/** Strip ANSI escape / control sequences so regexes match on visible text. */
export function stripAnsi(input: string): string {
  return input
    // OSC sequences: ESC ] ... BEL  or  ESC ] ... ESC \
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    // CSI sequences: ESC [ ... final-byte
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // Other two-char escapes: ESC <char>
    .replace(/\u001B[@-Z\\-_]/g, '')
    // Remaining C0 control chars except \n and \t
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

type ChangeHandler = (state: SessionState, reason: DetectionReason) => void

/**
 * StateDetector processes one session's output over time and reports state
 * changes via onChange. Drive it with pushOutput() (on PTY data), notifyInput()
 * (when the user sends keystrokes), markExited(), and tick() (on a timer).
 */
export class StateDetector {
  private readonly cfg: DetectionConfig
  private readonly onChange: ChangeHandler
  private _state: SessionState = 'STARTING'
  private _reason: DetectionReason = 'none'
  private buf = ''
  private lastOutputAt: number
  private hasOutput = false
  // After the user sends input, the agent is working — suppress any "waiting"
  // verdict until it actually produces output again (SPEC §6: "waiting ≈ … and
  // we haven't sent input since"). Prevents a false red dot + notification
  // during think-time / a tool or network stall right after your prompt.
  private awaitingOutputSinceInput = false
  // When the user last sent input. Used to grant a post-input grace window
  // during which the low-confidence silence fallback is suppressed.
  private lastInputAt = Number.NEGATIVE_INFINITY
  // Debounce bookkeeping for the WORKING → WAITING transition.
  private pending: SessionState | null = null
  private pendingSince = 0

  constructor(now: number, cfg: DetectionConfig, onChange: ChangeHandler) {
    // Merge defaults so partially-specified configs are safe.
    this.cfg = { ...DEFAULT_DETECTION, ...cfg }
    this.onChange = onChange
    this.lastOutputAt = now
  }

  get state(): SessionState {
    return this._state
  }

  get reason(): DetectionReason {
    return this._reason
  }

  private set(next: SessionState, reason: DetectionReason): void {
    this._reason = reason
    if (next !== this._state) {
      this._state = next
      this.onChange(next, reason)
    }
  }

  /** Called when the PTY emits data. Flowing output always means WORKING. */
  pushOutput(chunk: string, now: number): void {
    if (TERMINAL_STATES.includes(this._state)) return
    this.lastOutputAt = now
    this.hasOutput = true
    this.awaitingOutputSinceInput = false
    const animating = this.cfg.spinnerRegex ? this.cfg.spinnerRegex.test(chunk) : false
    this.buf = (this.buf + stripAnsi(chunk)).slice(-4000)
    this.pending = null
    this.set('WORKING', animating ? 'spinner' : 'streaming')
  }

  /** Called when the user sends input; the agent is about to work. */
  notifyInput(now: number): void {
    if (TERMINAL_STATES.includes(this._state)) return
    this.lastOutputAt = now
    this.lastInputAt = now
    this.pending = null
    this.awaitingOutputSinceInput = true
    this.set('WORKING', 'streaming')
  }

  markExited(code: number | null): void {
    this.set(code && code !== 0 ? 'ERROR' : 'EXITED', 'none')
  }

  /** Periodic evaluation of quiescence timers. Call every ~200-300ms. */
  tick(now: number): void {
    if (TERMINAL_STATES.includes(this._state)) return
    const quietFor = now - this.lastOutputAt
    if (quietFor < this.cfg.quietMs) {
      this.pending = null // still streaming
      return
    }

    // We sent input and the agent hasn't produced output yet — it's working, not
    // waiting. Hold WORKING until output arrives (which clears this flag).
    if (this.awaitingOutputSinceInput) {
      this.pending = null
      return
    }

    const tail = this.buf.slice(-600)

    // High-confidence prompt signatures win outright (not gated by the grace window).
    if (this.cfg.approvalRegex && this.cfg.approvalRegex.test(tail)) {
      this.commit('WAITING_APPROVAL', 'approval-prompt', now)
      return
    }
    if (this.cfg.promptRegex && this.cfg.promptRegex.test(tail)) {
      this.commit('WAITING_INPUT', 'input-prompt', now)
      return
    }

    // Low-confidence zone. Right after your input (grace window), assume the
    // agent is still working on it rather than declaring idle/waiting — terminal
    // echo of your keystrokes would otherwise make think-time look "done".
    if (now - this.lastInputAt < this.cfg.inputGraceMs) {
      this.pending = null
      return
    }

    if (
      this.hasOutput &&
      this.cfg.assumeWaitingAfterMs != null &&
      quietFor >= this.cfg.assumeWaitingAfterMs
    ) {
      this.commit('WAITING_INPUT', 'silence', now)
      return
    }

    // Quiet but unrecognized and past the grace window. Only after the agent has
    // actually produced output — before that we stay in STARTING.
    this.pending = null
    if (this.hasOutput && this._state === 'WORKING') {
      this.set('IDLE', 'idle')
    }
  }

  /** Apply confirmMs debounce hysteresis before committing a WAITING_* verdict. */
  private commit(next: SessionState, reason: DetectionReason, now: number): void {
    if (this.pending !== next) {
      this.pending = next
      this.pendingSince = now
    }
    if (now - this.pendingSince >= this.cfg.confirmMs) {
      this.set(next, reason)
    }
  }
}
