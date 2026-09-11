// Session manager: owns the node-pty processes, runs one StateDetector per
// session on a shared timer, and emits output/state/roster + WORKING→WAITING
// transitions. This is the only place that touches node-pty.

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  StateDetector,
  DEFAULT_DETECTION,
  stripAnsi,
  detectDevUrl,
  type DetectionConfig,
  type DetectionReason
} from '../shared/detection'
import { CostParser, DEFAULT_COST_REGEX_SRC, DEFAULT_CREDITS_REGEX_SRC } from '../shared/cost'
import type { SessionInfo, CreateSessionRequest, SessionState } from '../shared/types'
import type { ActivityEvent } from '../shared/api'
import { getPreset } from './presets'
import { defaultShell } from './platform'
import { pickCharacter, isCharacterId } from './characters'
import { briefPathFor, primerFor, resolveContext } from './handoff'
import { statSync } from 'node:fs'
import {
  normalizeSetNames,
  addToSets,
  removeFromSets,
  addMembership,
  removeMembership,
  moveMembership
} from '../shared/workspaces'
import { randomCharacterColor, fallbackCharacterColor } from '../shared/palette'
import { Store, identityKey, type PersistedSession } from './store'
import type { TranscriptRecorder } from './transcripts'
import { AutopilotWatcher, CopilotAutopilotWatcher, isClaudeSession, isCopilotSession } from './autopilot'
import { crewHookFor } from './crew-hook'
import { DEFAULT_COPILOT_MODEL, withCopilotModel, withoutCopilotModel } from '../shared/copilot-models'

const TICK_MS = 250
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const EVENT_CAP = 2000
// Poll agent autopilot state every ~1s (4 ticks) — cheap, since a session's
// transcript / event log is only re-read when it actually changes.
const AUTOPILOT_POLL_TICKS = 4
// How many saved sessions to re-launch at once on startup, and the gap between
// batches. Each session spawns a PTY that immediately streams its agent's boot
// output into its own terminal engine, so restoring a large roster in one tick
// saturates the renderer and flickers the whole window until it catches up.

/**
 * How often buffered PTY output is flushed to the renderer, and how much of a
 * single session's backlog is kept when it outruns that.
 *
 * A PTY can emit far faster than a renderer can draw. Forwarding every chunk the
 * moment it arrives means one IPC message per chunk per session: with a large
 * roster — especially at startup, when every resumed agent replays its whole
 * conversation at once — the renderer cannot drain the channel, and the
 * undelivered strings pile up until it exhausts its memory and is killed.
 * Rebuilding a dead renderer repaints the whole window, which is what the user
 * sees as flicker.
 *
 * So output is coalesced per session and flushed on a timer: one message per
 * session per interval, holding at most PENDING_CAP bytes. 40 ms is well under
 * a frame's worth of latency for a human reading a terminal, and the cap is far
 * more than a terminal can display in one flush — past it the OLDEST bytes are
 * dropped, because what a burst-dumping session actually shows is its tail.
 */
const OUTPUT_FLUSH_MS = 40
const PENDING_CAP = 512 * 1024

interface Managed {
  /**
   * Starts this session's agent process. Held so a session restored ASLEEP can
   * be launched later, on the first thing that actually needs it running.
   */
  start?: () => void
  info: SessionInfo
  proc: pty.IPty | null
  detector: StateDetector | null
  cost: CostParser
  credits: CostParser
  cols: number
  rows: number
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

/**
 * Size of an agent conversation's own event log, or 0 when there isn't one.
 *
 * Only used to distinguish a not-yet-started successor from an existing
 * conversation. This is not a measure of the provider's token/context budget.
 */
function transcriptBytes(agentSessionId: string | undefined): number | undefined {
  if (!agentSessionId) return 0
  try {
    return statSync(join(homedir(), '.copilot', 'session-state', agentSessionId, 'events.jsonl')).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    console.warn('[crew] Could not inspect conversation history:', error)
    return undefined
  }
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Managed>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly events: ActivityEvent[] = []
  // Coalesces cost-driven roster updates into the tick loop (max ~4/s).
  private rosterDirty = false
  // Set when session metadata that must survive restart changes (e.g. a prompt
  // stamps lastPromptAt); flushed to disk on the tick so we don't writeFile on
  // every keystroke.
  private persistDirty = false
  // Detects autopilot from each agent's own state: Claude Code's acceptEdits from
  // its transcript; Copilot's "autopilot" mode from its session event log.
  private readonly autopilot = new AutopilotWatcher()
  private readonly copilotAutopilot = new CopilotAutopilotWatcher()
  private readonly autopilotPending = new Set<Managed>()
  private autopilotTick = 0
  // Set during shutdown so PTY exit handlers don't overwrite the saved session
  // list with an empty one (which would defeat resume-on-next-launch).
  private disposing = false
  private restoring = false
  /** Per-session output waiting to be sent to the renderer (see OUTPUT_FLUSH_MS). */
  private pendingOutput = new Map<string, { parts: string[]; len: number; dropped: boolean }>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private readonly recordingPaused = new Map<string, pty.IPty>()

  private readonly onRecordingBlocked = (id: string): void => {
    const m = this.sessions.get(id)
    if (!m?.proc || m.info.status !== 'active' || this.recordingPaused.has(id)) return
    try {
      m.proc.pause()
      this.recordingPaused.set(id, m.proc)
      this.bufferOutput(id, '\r\n[Crew] Terminal output paused: transcript storage is unavailable. Free disk space or restore folder access; capture will retry automatically.\r\n')
    } catch (error) {
      console.warn(`[crew] Could not pause terminal output for ${id}:`, error)
      this.bufferOutput(id, `\r\n[Crew] Could not pause terminal output after a storage failure: ${error instanceof Error ? error.message : String(error)}\r\n`)
    }
  }

  private readonly onRecordingDrained = (id: string): void => {
    const proc = this.recordingPaused.get(id)
    if (!proc) return
    this.recordingPaused.delete(id)
    const m = this.sessions.get(id)
    if (this.disposing || m?.proc !== proc || m.info.status !== 'active') return
    try {
      proc.resume()
      this.bufferOutput(id, '\r\n[Crew] Transcript storage recovered; terminal output resumed.\r\n')
    } catch (error) {
      console.warn(`[crew] Could not resume terminal output for ${id}:`, error)
      this.bufferOutput(id, `\r\n[Crew] Storage recovered, but terminal output could not resume: ${error instanceof Error ? error.message : String(error)}\r\n`)
    }
  }

  constructor(
    private readonly store: Store,
    private readonly recorder?: TranscriptRecorder,
    /** Dir holding the materialized crew-hook shell-integration scripts. */
    private readonly crewHookDir?: string
  ) {
    super()
    this.recorder?.on('blocked', this.onRecordingBlocked)
    this.recorder?.on('drained', this.onRecordingDrained)
  }

  roster(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }))
  }

  create(
    req: CreateSessionRequest,
    restore?: { id?: string; agentSessionId?: string; priorSessionId?: string; characterId?: string; color?: string; extraArgs?: string[]; tag?: string; sets?: string[]; workspaceIds?: string[]; description?: string; createdAt?: number; lastPromptAt?: number; defer?: boolean }
  ): SessionInfo {
    const preset = getPreset(req.presetId)
    const command = req.command || preset?.command || defaultShell()
    const baseArgs = req.args && req.args.length ? req.args : preset?.args ?? []
    const copilot = req.presetId === 'copilot-cli'
    const args = copilot && !restore && !baseArgs.some((arg) => arg === '--model' || arg.startsWith('--model='))
      ? withCopilotModel(baseArgs, DEFAULT_COPILOT_MODEL)
      : [...baseArgs]
    const cwd = req.cwd || homedir() || process.cwd()
    const id = restore?.id ?? randomUUID()
    // The agent's own session UUID: reused when resuming (so we reattach the same
    // conversation), freshly minted otherwise. Passed via the preset's
    // sessionIdFlag (e.g. Copilot's --session-id=).
    const legacyResume = restore && !restore.agentSessionId && !restore.priorSessionId && Boolean(restore.extraArgs?.length)
    const agentSessionId = legacyResume ? undefined : restore?.agentSessionId ?? randomUUID()
    const now = Date.now()

    const key = identityKey(req.presetId, cwd)
    // Character usage across active sessions, WITH duplicates, so pickCharacter
    // can hand out a least-used character once every character is taken (rather
    // than getting stuck on one).
    const usedChars = [...this.sessions.values()]
      .filter((m) => m.info.status === 'active')
      .map((m) => m.info.characterId)
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

    const base = basename(cwd) || 'session'
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
      priorSessionId: restore?.priorSessionId,
      cwd,
      state: 'STARTING',
      status: 'active',
      pid: null,
      exitCode: null,
      costUsd: 0,
      creditsUsed: 0,
      autopilot: false,
      tag: restore?.tag ?? (req.tag && req.tag.trim() ? req.tag.trim() : undefined),
      sets,
      workspaceIds: restore?.workspaceIds ?? req.workspaceIds ?? [],
      description: restore?.description,
      createdAt: restore?.createdAt ?? now,
      stateChangedAt: now,
      lastPromptAt: restore?.lastPromptAt ?? now
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

    const detector = new StateDetector(now, cfg, (state, reason) => this.onState(id, state, reason))
    const managed: Managed = { info, proc: null, detector: null, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
    const start = (): void => {
    let proc: pty.IPty
    try {
      // Launch-time args (never persisted into info.args, so flags never
      // accumulate). For an agent with a session-id flag (Copilot): mint a fresh
      // --session-id for a new session, reuse it to reattach on a known resume,
      // and fall back to --continue only for a legacy session whose id we never
      // captured. Other agents (Claude) just get their resume args.
      let idArgs: string[] = []
      let resumeExtra = restore?.extraArgs ?? []
      if (copilot && restore && this.store.settings.resumeConversations &&
          this.store.settings.contextMode === 'transcript' && info.priorSessionId &&
          transcriptBytes(info.agentSessionId) === 0) {
        info.agentSessionId = info.priorSessionId
        info.priorSessionId = undefined
      }
      if (preset?.sessionIdFlag && info.agentSessionId) {
        idArgs = [preset.sessionIdFlag + info.agentSessionId]
        resumeExtra = []
      }
      const needsBrief = copilot && this.store.settings.resumeConversations &&
        this.store.settings.contextMode !== 'transcript' && info.priorSessionId &&
        transcriptBytes(info.agentSessionId) === 0
      const brief = needsBrief ? briefPathFor(info.priorSessionId) : null
      if (needsBrief && !brief) {
        throw new Error(`Saved context brief is missing or ambiguous. Both conversation IDs are preserved. Regenerate the brief or resume the original with copilot --resume=${info.priorSessionId}.`)
      }
      const prompt = brief ? primerFor(brief) : req.initialPrompt
      const contextArgs = copilot && prompt
        ? [...(brief ? ['--add-dir', dirname(brief)] : []), '--interactive', prompt]
        : []
      if (copilot && restore && this.store.settings.resumeConversations &&
          this.store.settings.contextMode === 'brief' && !brief) {
        this.emit('output', { id, data: '\r\n[Crew] No verified brief for this conversation; resuming native context instead.\r\n' })
      }
      if (copilot && legacyResume) {
        this.emit('output', { id, data: '\r\n[Crew] This legacy entry has no recorded conversation ID. Copilot will use --continue; verify that it selects the intended conversation.\r\n' })
      }
      // Enhanced Terminal: install OSC 133 shell integration for the Shell
      // preset so command blocks / jump-to-prompt / exit-code marks work. Opt-in
      // (the setting is off by default) and only for a real zsh/bash shell;
      // agents, custom commands, and other shells are left completely untouched.
      const hook =
        this.store.settings.enhancedTerminal && req.presetId === 'shell' && this.crewHookDir
          ? crewHookFor(command, this.crewHookDir)
          : null
      const nativeModel = copilot && restore && !brief &&
        (legacyResume || transcriptBytes(info.agentSessionId) !== 0)
      const launchArgs = nativeModel ? withoutCopilotModel(args) : args
      const spawnArgs = [...launchArgs, ...idArgs, ...resumeExtra, ...(hook?.extraArgs ?? []), ...contextArgs]
      proc = pty.spawn(command, spawnArgs, {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', ...(hook?.env ?? {}) } as Record<string, string>
      })
    } catch (err) {
      // Command not found / not executable: surface as an ERROR card rather
      // than crashing. The user can dismiss or fix the command and retry.
      info.state = 'ERROR'
      info.status = 'error'
      info.exitCode = 127
      info.errorMessage = `Failed to launch ${command} in ${cwd}: ${err instanceof Error ? err.message : String(err)}`
      managed.proc = null
      managed.detector = null
      this.emitRoster()
      const message = err instanceof Error ? err.message : String(err)
      this.emit('output', { id, data: `\r\n\x1b[31mFailed to launch \x1b[1m${command}\x1b[0m\x1b[31m: ${message}\x1b[0m\r\n` })
      return
    }

    info.pid = proc.pid
    info.exitCode = null
    info.errorMessage = undefined
    info.state = 'STARTING'
    info.status = 'active'
    info.stateChangedAt = Date.now()
    managed.proc = proc
    managed.detector = detector

    proc.onData((data) => {
      // Ignore any final flush that arrives after the session was closed/removed
      // (prevents resurrecting a disposed renderer terminal).
      if (!this.sessions.has(id)) return
      // Coalesced rather than emitted per chunk — see OUTPUT_FLUSH_MS. Everything
      // below stays synchronous: detection, cost and transcript capture are cheap
      // main-side work, and delaying them would delay state changes the user sees.
      this.bufferOutput(id, data)
      managed.detector?.pushOutput(data, Date.now())
      const clean = stripAnsi(data)
      if (this.recorder && this.store.settings.captureTranscripts) this.recorder.append(id, clean)
      if (managed.cost.push(clean)) {
        managed.info.costUsd = managed.cost.usd
        this.rosterDirty = true
      }
      if (managed.credits.push(clean)) {
        managed.info.creditsUsed = managed.credits.value
        this.rosterDirty = true
      }
      // Watch for a dev-server URL the agent printed, to power the "App" pane.
      const url = detectDevUrl(clean)
      if (url && url !== managed.info.appUrl) {
        managed.info.appUrl = url
        this.rosterDirty = true
      }
    })

    proc.onExit(({ exitCode, signal }) => {
      const errored = Boolean(exitCode) || Boolean(signal)
      managed.info.exitCode = exitCode
      managed.info.status = errored ? 'error' : 'exited'
      managed.info.autopilot = false
      this.recordingPaused.delete(id)
      this.autopilot.forget(id)
      this.copilotAutopilot.forget(id)
      if (errored && !managed.info.errorMessage) {
        managed.info.errorMessage = signal
          ? `${managed.info.command} was terminated by signal ${signal}`
          : `${managed.info.command} exited with code ${exitCode}`
      }
      managed.detector?.markExited(errored ? exitCode || 1 : 0)
      this.stopTimerIfIdle()
      this.persistSessions()
    })

    if (!copilot && req.initialPrompt && req.initialPrompt.length) {
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
    }

    managed.start = start
    this.sessions.set(id, managed)
    this.store.setAssignment(key, { characterId, lastLabel: label })

    if (restore?.defer) {
      // On the roster, off the CPU: no process, no terminal, no output — until
      // someone opens it. See wake().
      info.state = 'ASLEEP'
      this.emitRoster()
      this.persistSessions()
      return { ...info }
    }

    start()
    return { ...info }
  }

  /**
   * Start a session that was restored asleep. Idempotent, and a no-op for a
   * session that is already running, has exited, or failed to launch — so
   * callers (opening a tile, typing, sending a prompt) can call it freely
   * without first working out whether it is needed.
   */
  wake(id: string): void {
    const m = this.sessions.get(id)
    if (!m || m.info.state !== 'ASLEEP' || !m.start) return
    m.start()
  }

  input(id: string, data: string): void {
    // Typing into a sleeping session is a clear instruction to run it. The
    // keystroke itself is dropped — the agent is still booting and has no
    // prompt drawn yet, so writing now would only lose it somewhere worse.
    this.wake(id)
    const m = this.sessions.get(id)
    if (!m || !m.proc) return
    try {
      m.proc.write(data)
    } catch {
      /* exited */
    }
    m.detector?.notifyInput(Date.now())
    // A carriage return/newline means the user submitted a prompt — stamp it so
    // the 'recent' grouping re-buckets this session as most-recent. Flushed via
    // the debounced rosterDirty tick (avoids emitting on every keystroke), and
    // persisted (persistDirty) so the timestamp survives restart/reinstall.
    if (data.includes('\r') || data.includes('\n')) {
      m.info.lastPromptAt = Date.now()
      this.rosterDirty = true
      this.persistDirty = true
    }
  }

  setTag(id: string, tag: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    const next = tag.trim() || undefined
    if (m.info.tag === next) return
    m.info.tag = next
    // Re-slot the session to the end of the roster so grouped views place it at
    // the end of its new group (where a freshly-added group member belongs),
    // rather than leaving it stranded at its old position mid-group. Deleting
    // then re-setting the Map key moves it to the end (insertion order).
    this.sessions.delete(id)
    this.sessions.set(id, m)
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

  // ── First-class workspace membership (by id) ──────────────────────────────

  /** Replace a session's workspace-id membership wholesale. */
  setWorkspaceIds(id: string, workspaceIds: string[]): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.workspaceIds = [...new Set(workspaceIds)]
    this.emitRoster()
    this.persistSessions()
  }

  /** Add a session to a workspace (non-destructive; keeps existing memberships). */
  addToWorkspace(id: string, wsId: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.workspaceIds = addMembership(m.info.workspaceIds, wsId)
    this.emitRoster()
    this.persistSessions()
  }

  /** Remove a session from a single workspace. */
  removeFromWorkspace(id: string, wsId: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId)
    this.emitRoster()
    this.persistSessions()
  }

  /** Move a session from one workspace to another (drop from, add to). */
  moveToWorkspace(id: string, fromId: string, toId: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.workspaceIds = moveMembership(m.info.workspaceIds, fromId, toId)
    this.emitRoster()
    this.persistSessions()
  }

  /** Archive a session: remove it from every workspace (keeps it running). */
  archiveSession(id: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.workspaceIds = []
    this.emitRoster()
    this.persistSessions()
  }

  /** Set (or clear, when blank) a session's freeform description. */
  setDescription(id: string, description: string): void {
    const m = this.sessions.get(id)
    if (!m) return
    m.info.description = description.trim() || undefined
    this.emitRoster()
    this.persistSessions()
  }

  /** Strip a workspace id from every session's membership (on workspace delete). */
  removeWorkspaceFromAll(wsId: string): void {
    for (const m of this.sessions.values()) {
      m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId)
    }
    this.emitRoster()
    this.persistSessions()
  }

  /** Spawn a fresh session reusing another's recipe, optionally into a workspace. */
  duplicateSession(id: string, wsId: string | null): SessionInfo | null {
    const m = this.sessions.get(id)
    if (!m) return null
    const info = this.create({
      presetId: m.info.presetId,
      command: m.info.command,
      args: m.info.args,
      cwd: m.info.cwd,
      label: m.info.label,
      tag: m.info.tag,
      workspaceIds: wsId ? [wsId] : []
    })
    return info
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
    // Undelivered output for a session that is going away would arrive after the
    // renderer disposed its terminal, resurrecting one that is never shown again.
    this.pendingOutput.delete(id)
    this.recordingPaused.delete(id)
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
    this.copilotAutopilot.forget(id)
    this.stopTimerIfIdle()
    this.emitRoster()
    this.persistSessions()
  }

  restart(id: string): SessionInfo | null {
    const m = this.sessions.get(id)
    if (!m) return null
    if (m.info.status === 'error' && !m.proc && m.start) {
      m.start()
      return { ...m.info }
    }
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

  /**
   * Queue a session's output for the renderer instead of sending it immediately.
   * Keeps at most PENDING_CAP bytes per session, dropping the OLDEST first: a
   * session dumping megabytes (a resumed agent replaying its conversation) can
   * outrun any renderer, and what it ultimately displays is the tail.
   */
  private bufferOutput(id: string, data: string): void {
    let buf = this.pendingOutput.get(id)
    if (!buf) {
      buf = { parts: [], len: 0, dropped: false }
      this.pendingOutput.set(id, buf)
    }
    buf.parts.push(data)
    buf.len += data.length
    while (buf.len > PENDING_CAP && buf.parts.length > 1) {
      buf.len -= buf.parts.shift()!.length
      buf.dropped = true
    }
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushOutput(), OUTPUT_FLUSH_MS)
    }
  }

  /** Send each session's buffered output as a single message, then idle. */
  private flushOutput(): void {
    if (this.pendingOutput.size === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer)
        this.flushTimer = null
      }
      return
    }
    for (const [id, buf] of this.pendingOutput) {
      const data = buf.parts.join('')
      this.pendingOutput.delete(id)
      if (!data) continue
      // Tell the reader when a burst outran the buffer, so a truncated screen is
      // never silently passed off as the agent's actual output.
      const notice = buf.dropped ? '\r\n\x1b[2m… earlier output trimmed …\x1b[0m\r\n' : ''
      this.emit('output', { id, data: notice + data })
    }
  }

  disposeAll(): void {
    // Capture the freshest state (e.g. a lastPromptAt stamped since the last
    // persist-triggering action) while sessions are still active — before we
    // freeze persistence and kill the procs.
    this.persistSessions()
    // Freeze persistence first: the kills below fire onExit handlers that would
    // otherwise save an empty session list and wipe the resume state.
    this.disposing = true
    this.recorder?.off('blocked', this.onRecordingBlocked)
    this.recorder?.off('drained', this.onRecordingDrained)
    this.recordingPaused.clear()
    // Deliver whatever is buffered before the window goes away, then stop.
    this.flushOutput()
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    for (const m of this.sessions.values()) {
      this.autopilot.forget(m.info.id)
      this.copilotAutopilot.forget(m.info.id)
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
    if (this.disposing || this.restoring) return
    // Persist every session still on the roster, whatever its status. An agent
    // that died (crashed on resume, killed by a failing MCP server, exited with
    // an error) must NOT be erased from the saved roster: status is transient,
    // membership is not. Intentional removal goes through close(), which deletes
    // the entry from `sessions` outright, so anything still in the map is a
    // session the user expects to see again next launch.
    const list: PersistedSession[] = [...this.sessions.values()]
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
        workspaceIds: m.info.workspaceIds,
        description: m.info.description,
        agentSessionId: m.info.agentSessionId,
        priorSessionId: m.info.priorSessionId,
        createdAt: m.info.createdAt,
        lastPromptAt: m.info.lastPromptAt
      }))
    this.store.saveSessions(list)
  }

  /**
   * Decide how a saved session regains its context on relaunch.
   *
   * Auto/transcript prefer native resume. Brief deliberately starts a fresh
   * Copilot conversation only when a verified handoff exists.
   *
   * Either way the original conversation id survives — as agentSessionId when
   * reattaching, as priorSessionId when superseding — so a relaunch can never
   * orphan a transcript. That matters even with resume switched off, where the
   * id used to be dropped and then overwritten by the next persist.
   */
  private contextFor(
    agentSessionId: string | undefined,
    priorSessionId: string | undefined,
    presetId: string | null
  ): { agentSessionId?: string; priorSessionId?: string; extraArgs: string[] } {
    return resolveContext({
      agentSessionId,
      priorSessionId,
      resume: this.store.settings.resumeConversations,
      contextMode: presetId === 'copilot-cli' ? this.store.settings.contextMode : 'transcript',
      resumeArgs: getPreset(presetId)?.resumeArgs,
      transcriptBytes: transcriptBytes(agentSessionId),
      hasBrief: briefPathFor(agentSessionId) != null,
      hasPriorBrief: briefPathFor(priorSessionId) != null
    })
  }

  /**
   * Bring back the sessions saved from a previous run — asleep.
   *
   * A live agent can't literally be frozen, so a restored session is really a
   * fresh launch of the same agent, cwd, label and character. Doing that for a
   * whole roster the moment the app opened meant dozens of agents booting and
   * replaying their conversations into dozens of live terminals at once; the
   * window could not keep up, and on a large roster the display ran out of
   * memory and was restarted, repainting everything — the flicker.
   *
   * So restoring now costs nothing. Every saved session reappears immediately,
   * complete and in its right group, but with no process behind it; the agent
   * starts when the session is opened or typed into (see wake()). Launch is
   * instant regardless of roster size, and only the sessions actually being
   * used consume anything.
   */
  restore(): SessionInfo[] {
    this.restoring = true
    return this.store.batchUpdates(() => {
      const restored = this.store.getSessions().map((p) => this.restoreOne(p))
      this.restoring = false
      this.persistSessions()
      return restored
    })
  }

  private restoreOne(p: PersistedSession): SessionInfo {
    const ctx = this.contextFor(p.agentSessionId, p.priorSessionId, p.presetId)
    return this.create(
      { presetId: p.presetId, command: p.command, args: p.args, cwd: p.cwd, label: p.label },
      {
        id: p.id,
        agentSessionId: ctx.agentSessionId,
        priorSessionId: ctx.priorSessionId,
        characterId: p.characterId,
        color: p.color ?? fallbackCharacterColor(p.id),
        extraArgs: ctx.extraArgs,
        tag: p.tag,
        sets: p.sets,
        workspaceIds: p.workspaceIds,
        description: p.description,
        createdAt: p.createdAt,
        lastPromptAt: p.lastPromptAt,
        defer: true
      }
    )
  }

  /**
   * Re-launch a saved named set of sessions (see Store.sets). Like restore(),
   * this spawns each session fresh and applies the preset's resume args
   * (e.g. --continue) when conversation resume is enabled, so relaunching a set
   * genuinely resumes its agents rather than starting them cold.
   */
  launchSet(name: string, workspaceIds?: string[]): SessionInfo[] {
    const set = this.store.sets.find((s) => s.name === name)
    if (!set) return []
    return set.sessions.map((d) => {
      const ctx = this.contextFor(d.agentSessionId, d.priorSessionId, d.presetId)
      return this.create(
        { presetId: d.presetId, command: d.command, args: d.args, cwd: d.cwd, label: d.label },
        {
          id: d.id,
          agentSessionId: ctx.agentSessionId,
          priorSessionId: ctx.priorSessionId,
          characterId: d.characterId,
          color: d.color,
          extraArgs: ctx.extraArgs.length ? ctx.extraArgs : undefined,
          tag: d.tag,
          sets: d.sets,
          // Join the workspace being viewed, exactly as a newly created session
          // does. A set saved before workspaces existed belongs to none of them,
          // so resuming it under a filter would drop 36 sessions somewhere the
          // user isn't looking and read as nothing having happened.
          workspaceIds: workspaceIds?.length ? workspaceIds : undefined,
          // Asleep, like anything else coming back onto the roster: a set can be
          // dozens of sessions, and booting them all at once is the storm that
          // restore() no longer causes. They appear at once and start as opened.
          defer: true
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
      // Flush metadata that must survive restart (e.g. lastPromptAt from a
      // prompt) at most once per tick.
      if (this.persistDirty) {
        this.persistDirty = false
        this.persistSessions()
      }
    }, TICK_MS)
  }

  /** Refresh autopilot state for active agent sessions (throttled). */
  private pollAutopilot(): void {
    this.autopilotTick = (this.autopilotTick + 1) % AUTOPILOT_POLL_TICKS
    if (this.autopilotTick !== 0) return
    for (const m of this.sessions.values()) {
      if (!m.proc || m.info.status !== 'active' || this.autopilotPending.has(m)) continue
      if (!isClaudeSession(m.info) && !isCopilotSession(m.info)) continue
      this.autopilotPending.add(m)
      void this.refreshAutopilot(m)
    }
  }

  private async refreshAutopilot(m: Managed): Promise<void> {
    const proc = m.proc
    try {
      const on = isClaudeSession(m.info)
        ? this.autopilot.isAutopilot(m.info.id, m.info.cwd)
        : await this.copilotAutopilot.isAutopilot(m.info.id, m.info.agentSessionId)
      if (this.disposing || this.sessions.get(m.info.id) !== m || m.proc !== proc || m.info.status !== 'active') return
      if (on !== m.info.autopilot) {
        m.info.autopilot = on
        this.rosterDirty = true
      }
    } catch (error) {
      console.warn(`[autopilot] Could not refresh ${m.info.id}:`, error)
    } finally {
      this.autopilotPending.delete(m)
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
