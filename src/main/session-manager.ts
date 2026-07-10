// Session manager: owns the node-pty processes, runs one StateDetector per
// session on a shared timer, and emits output/state/roster + WORKING→WAITING
// transitions. This is the only place that touches node-pty.

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  StateDetector,
  DEFAULT_DETECTION,
  stripAnsi,
  type DetectionConfig,
  type DetectionReason
} from '../shared/detection'
import { CostParser, DEFAULT_COST_REGEX_SRC, DEFAULT_CREDITS_REGEX_SRC } from '../shared/cost'
import type { SessionInfo, CreateSessionRequest, SessionState } from '../shared/types'
import type { ActivityEvent } from '../shared/api'
import { getPreset } from './presets'
import { pickCharacter, isCharacterId } from './characters'
import { normalizeSetNames, addToSets, removeFromSets } from '../shared/workspaces'
import { randomCharacterColor, fallbackCharacterColor } from '../shared/palette'
import { Store, identityKey, type PersistedSession } from './store'
import type { TranscriptRecorder } from './transcripts'
import { AutopilotWatcher, isClaudeSession, isCopilotSession, isCopilotAutopilot } from './autopilot'

const TICK_MS = 250
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const EVENT_CAP = 2000
// Poll Claude transcripts for autopilot every ~1s (4 ticks) — cheap, since an
// unchanged transcript is not re-read.
const AUTOPILOT_POLL_TICKS = 4
// Recent ANSI-stripped output kept per Copilot session so pollAutopilot can read
// the current approval mode from its TUI footer. Small: the footer redraws often.
const COPILOT_TAIL_CHARS = 16384

interface Managed {
  info: SessionInfo
  proc: pty.IPty | null
  detector: StateDetector | null
  cost: CostParser
  credits: CostParser
  cols: number
  rows: number
  // ANSI-stripped output tail; used to read the Copilot CLI autopilot footer.
  outTail: string
}

export interface Transition {
  session: SessionInfo
  from: SessionState
  to: SessionState
}

export interface SessionManagerEvents {
  output: (p: { id: string; data: string }) => void
  state: (info: SessionInfo) => void
  roster: (roster: SessionInfo[]) => void
  transition: (t: Transition) => void
}

export declare interface SessionManager {
  on<E extends keyof SessionManagerEvents>(event: E, listener: SessionManagerEvents[E]): this
  emit<E extends keyof SessionManagerEvents>(
    event: E,
    ...args: Parameters<SessionManagerEvents[E]>
  ): boolean
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Managed>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly events: ActivityEvent[] = []
  // Coalesces cost-driven roster updates into the tick loop (max ~4/s).
  private rosterDirty = false
  // Detects Claude Code autopilot (acceptEdits) from session transcripts;
  // Copilot CLI autopilot is read from its TUI footer (see pollAutopilot).
  private readonly autopilot = new AutopilotWatcher()
  private autopilotTick = 0
  // Set during shutdown so PTY exit handlers don't overwrite the saved session
  // list with an empty one (which would defeat resume-on-next-launch).
  private disposing = false

  constructor(
    private readonly store: Store,
    private readonly recorder?: TranscriptRecorder
  ) {
    super()
  }

  roster(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }))
  }

  create(
    req: CreateSessionRequest,
    restore?: { id?: string; agentSessionId?: string; characterId?: string; color?: string; extraArgs?: string[]; tag?: string; sets?: string[] }
  ): SessionInfo {
    const preset = getPreset(req.presetId)
    const command = req.command || preset?.command || process.env.SHELL || '/bin/zsh'
    const args = req.args && req.args.length ? req.args : preset?.args ?? []
    const cwd = req.cwd || process.env.HOME || process.cwd()
    const id = restore?.id ?? randomUUID()
    // The agent's own session UUID: reused when resuming (so we reattach the same
    // conversation), freshly minted otherwise. Passed via the preset's
    // sessionIdFlag (e.g. Copilot's --session-id=).
    const agentSessionId = restore?.agentSessionId ?? randomUUID()
    const now = Date.now()

    const key = identityKey(req.presetId, cwd)
    const usedChars = new Set(
      [...this.sessions.values()]
        .filter((m) => m.info.status === 'active')
        .map((m) => m.info.characterId)
    )
    const saved = this.store.getAssignment(key)
    // Heal invalid character ids (e.g. a legacy session UUID stored as the
    // characterId, which would render as a bare colored circle) by falling back
    // to a real, unused character instead of trusting the persisted value.
    const requested = restore?.characterId
    const characterId = isCharacterId(requested)
      ? (requested as string)
      : pickCharacter(usedChars, saved?.characterId)
    const color = restore?.color ?? randomCharacterColor()
    // Workspace membership: from a restore/set descriptor, else the create
    // request's chosen workspaces. Register the names so they persist and appear
    // in the Change Workspace menu even before a snapshot is saved.
    const sets = normalizeSetNames(restore?.sets ?? req.sets ?? [])
    if (sets.length) this.store.ensureSets(sets)

    const base = cwd.split('/').filter(Boolean).pop() || 'session'
    const label =
      req.label?.trim() ||
      saved?.lastLabel ||
      `${preset ? preset.name + ' · ' : ''}${base}`

    const info: SessionInfo = {
      id,
      label,
      characterId,
      color,
      presetId: req.presetId,
      command,
      args,
      agentSessionId,
      cwd,
      state: 'STARTING',
      status: 'active',
      pid: null,
      exitCode: null,
      costUsd: 0,
      creditsUsed: 0,
      autopilot: false,
      tag: restore?.tag,
      sets,
      createdAt: now,
      stateChangedAt: now
    }

    const cfg: DetectionConfig = {
      quietMs: preset?.quietMs ?? DEFAULT_DETECTION.quietMs,
      confirmMs: preset?.confirmMs ?? DEFAULT_DETECTION.confirmMs,
      inputGraceMs: preset?.inputGraceMs ?? DEFAULT_DETECTION.inputGraceMs,
      assumeWaitingAfterMs:
        preset?.assumeWaitingAfterMs === undefined
          ? DEFAULT_DETECTION.assumeWaitingAfterMs
          : preset.assumeWaitingAfterMs,
      promptRegex: compileRegex(preset?.promptRegex),
      approvalRegex: compileRegex(preset?.approvalRegex),
      spinnerRegex: DEFAULT_DETECTION.spinnerRegex
    }

    const cost = new CostParser({ costRegex: compileRegex(preset?.costRegex ?? DEFAULT_COST_REGEX_SRC) })
    const credits = new CostParser({ costRegex: compileRegex(DEFAULT_CREDITS_REGEX_SRC) })

    let proc: pty.IPty
    try {
      // Launch-time args (never persisted into info.args, so flags never
      // accumulate). For an agent with a session-id flag (Copilot): mint a fresh
      // --session-id for a new session, reuse it to reattach on a known resume,
      // and fall back to --continue only for a legacy session whose id we never
      // captured. Other agents (Claude) just get their resume args.
      let idArgs: string[] = []
      let resumeExtra = restore?.extraArgs ?? []
      if (preset?.sessionIdFlag && (restore?.agentSessionId || !restore)) {
        idArgs = [preset.sessionIdFlag + agentSessionId]
        resumeExtra = []
      }
      const spawnArgs = [...args, ...idArgs, ...resumeExtra]
      proc = pty.spawn(command, spawnArgs, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
      })
    } catch (err) {
      // Command not found / not executable: surface as an ERROR card rather
      // than crashing. The user can dismiss or fix the command and retry.
      info.state = 'ERROR'
      info.status = 'error'
      info.exitCode = 127
      info.errorMessage = `Failed to launch ${command} in ${cwd}: ${err instanceof Error ? err.message : String(err)}`
      this.sessions.set(id, { info, proc: null, detector: null, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, outTail: '' })
      this.store.setAssignment(key, { characterId, lastLabel: label })
      this.emitRoster()
      const message = err instanceof Error ? err.message : String(err)
      this.emit('output', { id, data: `\r\n\x1b[31mFailed to launch \x1b[1m${command}\x1b[0m\x1b[31m: ${message}\x1b[0m\r\n` })
      return { ...info }
    }

    info.pid = proc.pid
    const detector = new StateDetector(now, cfg, (state, reason) => this.onState(id, state, reason))
    const managed: Managed = { info, proc, detector, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, outTail: '' }
    this.sessions.set(id, managed)
    this.store.setAssignment(key, { characterId, lastLabel: label })

    proc.onData((data) => {
      // Ignore any final flush that arrives after the session was closed/removed
      // (prevents resurrecting a disposed renderer terminal).
      if (!this.sessions.has(id)) return
      this.emit('output', { id, data })
      managed.detector?.pushOutput(data, Date.now())
      const clean = stripAnsi(data)
      // Copilot CLI exposes its approval mode only in the TUI footer; keep a
      // rolling tail so pollAutopilot can read it (Claude uses transcripts).
      if (isCopilotSession(managed.info)) {
        managed.outTail = (managed.outTail + clean).slice(-COPILOT_TAIL_CHARS)
      }
      if (this.recorder && this.store.settings.captureTranscripts) this.recorder.append(id, clean)
      if (managed.cost.push(clean)) {
        managed.info.costUsd = managed.cost.usd
        this.rosterDirty = true
      }
      if (managed.credits.push(clean)) {
        managed.info.creditsUsed = managed.credits.value
        this.rosterDirty = true
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      const errored = Boolean(exitCode) || Boolean(signal)
      managed.info.exitCode = exitCode
      managed.info.status = errored ? 'error' : 'exited'
      if (errored && !managed.info.errorMessage) {
        managed.info.errorMessage = signal
          ? `${managed.info.command} was terminated by signal ${signal}`
          : `${managed.info.command} exited with code ${exitCode}`
      }
      managed.detector?.markExited(errored ? exitCode || 1 : 0)
      this.stopTimerIfIdle()
      this.persistSessions()
    })

    if (req.initialPrompt && req.initialPrompt.length) {
      const text = req.initialPrompt
      // Give the agent a beat to draw its input UI before we type into it.
      setTimeout(() => {
        try {
          proc.write(text.endsWith('\n') ? text : text + '\r')
        } catch {
          /* process may have exited */
        }
      }, 700)
    }

    this.ensureTimer()
    this.emitRoster()
    this.persistSessions()
    return { ...info }
  }

  input(id: string, data: string): void {
    const m = this.sessions.get(id)
    if (!m || !m.proc) return
    try {
      m.proc.write(data)
    } catch {
      /* exited */
    }
    m.detector?.notifyInput(Date.now())
  }

  setTag(id: string, tag: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.tag = tag.trim() || undefined
    this.emitRoster()
    this.persistSessions()
  }

  /** Replace a session's workspace membership with `names` (deduped/validated). */
  setWorkspaces(id: string, names: string[]): void {
    const m = this.sessions.get(id)
    if (!m) return
    const sets = normalizeSetNames(names)
    m.info.sets = sets
    if (sets.length) this.store.ensureSets(sets)
    this.emitRoster()
    this.persistSessions()
  }

  /** Add workspace `name` to every currently-active session (used when saving a
   *  snapshot set, so existing sessions become members of that workspace). */
  addWorkspaceToActive(name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    for (const m of this.sessions.values()) {
      if (m.info.status !== 'active') continue
      m.info.sets = addToSets(m.info.sets, trimmed)
    }
    this.store.ensureSets([trimmed])
    this.emitRoster()
    this.persistSessions()
  }

  /** Strip workspace `name` from every session's membership (used on set delete). */
  removeWorkspaceEverywhere(name: string): void {
    for (const m of this.sessions.values()) {
      m.info.sets = removeFromSets(m.info.sets, name)
    }
    this.emitRoster()
    this.persistSessions()
  }

  resize(id: string, cols: number, rows: number): void {
    const m = this.sessions.get(id)
    if (!m || !m.proc) return
    if (cols < 1 || rows < 1) return
    m.cols = cols
    m.rows = rows
    try {
      m.proc.resize(cols, rows)
    } catch {
      /* exited */
    }
  }

  rename(id: string, label: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.label = label
    this.store.setAssignment(identityKey(m.info.presetId, m.info.cwd), {
      characterId: m.info.characterId,
      lastLabel: label
    })
    this.emitRoster()
    this.persistSessions()
  }

  setCharacter(id: string, characterId: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    // Ignore anything that isn't a real character (e.g. a stray session id),
    // which would otherwise persist and render as a bare colored circle.
    if (!isCharacterId(characterId)) return
    const previous = m.info.characterId
    if (previous === characterId) return
    // Keep active characters unique: if another active session already wears this
    // character, swap it onto the previous character instead of duplicating.
    const other = [...this.sessions.values()].find(
      (s) => s !== m && s.info.status === 'active' && s.info.characterId === characterId
    )
    m.info.characterId = characterId
    this.store.setAssignment(identityKey(m.info.presetId, m.info.cwd), {
      characterId,
      lastLabel: m.info.label
    })
    if (other) {
      other.info.characterId = previous
      this.store.setAssignment(identityKey(other.info.presetId, other.info.cwd), {
        characterId: previous,
        lastLabel: other.info.label
      })
    }
    this.emitRoster()
    this.persistSessions()
  }

  setColor(id: string, color: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    if (m.info.color === color) return
    m.info.color = color
    this.emitRoster()
    this.persistSessions()
  }

  /** Apply an explicit display order (drag-to-reorder). Unknown ids are ignored;
   * any existing sessions not listed are kept at the end. */
  reorder(orderedIds: string[]): void {
    const ordered: Array<[string, Managed]> = []
    const seen = new Set<string>()
    for (const id of orderedIds) {
      const m = this.sessions.get(id)
      if (m && !seen.has(id)) {
        ordered.push([id, m])
        seen.add(id)
      }
    }
    for (const [id, m] of this.sessions) {
      if (!seen.has(id)) ordered.push([id, m])
    }
    this.sessions.clear()
    for (const [id, m] of ordered) this.sessions.set(id, m)
    this.emitRoster()
    this.persistSessions()
  }

  close(id: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    if (m.proc) {
      try {
        m.proc.kill()
      } catch {
        /* already dead */
      }
    }
    this.sessions.delete(id)
    this.autopilot.forget(id)
    this.stopTimerIfIdle()
    this.emitRoster()
    this.persistSessions()
  }

  restart(id: string): SessionInfo | null {
    const m = this.sessions.get(id)
    if (!m) return null
    const req: CreateSessionRequest = {
      presetId: m.info.presetId,
      command: m.info.command,
      args: m.info.args,
      cwd: m.info.cwd,
      label: m.info.label
    }
    const character = m.info.characterId
    const color = m.info.color
    const idx = [...this.sessions.keys()].indexOf(id)
    this.close(id)
    const info = this.create(req)
    this.setCharacter(info.id, character)
    this.setColor(info.id, color)
    // Keep the restarted session in its original roster position.
    if (idx >= 0) {
      const ids = [...this.sessions.keys()].filter((x) => x !== info.id)
      ids.splice(idx, 0, info.id)
      this.reorder(ids)
    }
    // Return the live info: setCharacter drops an invalid legacy id, so the
    // session may have healed to a freshly-picked character.
    const healed = this.sessions.get(info.id)
    return healed ? { ...healed.info } : { ...info, color }
  }

  disposeAll(): void {
    // Freeze persistence first: the kills below fire onExit handlers that would
    // otherwise save an empty session list and wipe the resume state.
    this.disposing = true
    for (const m of this.sessions.values()) {
      if (m.proc) {
        try {
          m.proc.kill()
        } catch {
          /* ignore */
        }
      }
    }
    this.sessions.clear()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Snapshot the current active sessions so they can be resumed next launch. */
  private persistSessions(): void {
    if (this.disposing) return
    const list: PersistedSession[] = [...this.sessions.values()]
      .filter((m) => m.info.status === 'active')
      .map((m) => ({
        id: m.info.id,
        presetId: m.info.presetId,
        command: m.info.command,
        args: m.info.args,
        cwd: m.info.cwd,
        label: m.info.label,
        characterId: m.info.characterId,
        color: m.info.color,
        tag: m.info.tag,
        sets: m.info.sets,
        agentSessionId: m.info.agentSessionId
      }))
    this.store.saveSessions(list)
  }

  /**
   * Re-launch the sessions saved from a previous run. A live agent process can't
   * literally be frozen, so this restores the workspace layout — same agent, cwd,
   * label and character — by spawning each session fresh. Call once on startup.
   */
  restore(): SessionInfo[] {
    const persisted = this.store.getSessions()
    const resume = this.store.settings.resumeConversations
    return persisted.map((p) => {
      const preset = getPreset(p.presetId)
      const extraArgs = resume ? preset?.resumeArgs ?? [] : []
      return this.create(
        { presetId: p.presetId, command: p.command, args: p.args, cwd: p.cwd, label: p.label },
        {
          id: p.id,
          agentSessionId: resume ? p.agentSessionId : undefined,
          characterId: p.characterId,
          color: p.color ?? fallbackCharacterColor(p.id),
          extraArgs,
          tag: p.tag,
          sets: p.sets
        }
      )
    })
  }

  /**
   * Re-launch a saved named set of sessions (see Store.sets). Like restore(),
   * this spawns each session fresh and applies the preset's resume args
   * (e.g. --continue) when conversation resume is enabled, so relaunching a set
   * genuinely resumes its agents rather than starting them cold.
   */
  launchSet(name: string): SessionInfo[] {
    const set = this.store.sets.find((s) => s.name === name)
    if (!set) return []
    const resume = this.store.settings.resumeConversations
    return set.sessions.map((d) => {
      const preset = getPreset(d.presetId)
      const extraArgs = resume ? preset?.resumeArgs ?? [] : []
      return this.create(
        { presetId: d.presetId, command: d.command, args: d.args, cwd: d.cwd, label: d.label },
        {
          id: d.id,
          agentSessionId: resume ? d.agentSessionId : undefined,
          characterId: d.characterId,
          color: d.color,
          extraArgs: extraArgs.length ? extraArgs : undefined,
          tag: d.tag,
          sets: d.sets
        }
      )
    })
  }

  private onState(id: string, state: SessionState, reason?: DetectionReason): void {
    const m = this.sessions.get(id)
    if (!m) return
    const from = m.info.state
    const now = Date.now()
    m.info.state = state
    m.info.stateChangedAt = now
    if (reason) m.info.detectionReason = reason
    this.events.push({ id, ts: now, from, to: state })
    if (this.events.length > EVENT_CAP) this.events.splice(0, this.events.length - EVENT_CAP)
    const snapshot = { ...m.info }
    this.emit('state', snapshot)
    this.emitRoster()
    this.emit('transition', { session: snapshot, from, to: state })
  }

  getEvents(): ActivityEvent[] {
    return [...this.events]
  }

  private emitRoster(): void {
    this.emit('roster', this.roster())
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      const now = Date.now()
      for (const m of this.sessions.values()) m.detector?.tick(now)
      this.pollAutopilot()
      // Flush any cost updates accumulated from output since the last tick.
      if (this.rosterDirty) {
        this.rosterDirty = false
        this.emitRoster()
      }
    }, TICK_MS)
  }

  /** Refresh autopilot state for active agent sessions (throttled). */
  private pollAutopilot(): void {
    this.autopilotTick = (this.autopilotTick + 1) % AUTOPILOT_POLL_TICKS
    if (this.autopilotTick !== 0) return
    for (const m of this.sessions.values()) {
      if (m.info.status !== 'active') continue
      let on: boolean
      if (isClaudeSession(m.info)) {
        // Claude Code: read the permission mode from its session transcript.
        on = this.autopilot.isAutopilot(m.info.id, m.info.cwd)
      } else if (isCopilotSession(m.info)) {
        // Copilot CLI: read the mode from its TUI footer in recent output.
        // null = footer not in the tail → keep the last known state.
        const detected = isCopilotAutopilot(m.outTail)
        on = detected == null ? m.info.autopilot : detected
      } else {
        continue
      }
      if (on !== m.info.autopilot) {
        m.info.autopilot = on
        this.rosterDirty = true
      }
    }
  }

  private stopTimerIfIdle(): void {
    const anyActive = [...this.sessions.values()].some((m) => m.info.status === 'active')
    if (!anyActive && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

function compileRegex(src?: string): RegExp | null {
  if (!src) return null
  try {
    return new RegExp(src, 'm')
  } catch {
    return null
  }
}
