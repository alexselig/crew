// Session manager: owns the node-pty processes, runs one StateDetector per
// session on a shared timer, and emits output/state/roster + WORKING→WAITING
// transitions. This is the only place that touches node-pty.

import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { basename } from 'node:path'
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
const RESTORE_BATCH = 4
const RESTORE_BATCH_GAP_MS = 400

interface Managed {
  info: SessionInfo
  proc: pty.IPty | null
  detector: StateDetector | null
  cost: CostParser
  credits: CostParser
  cols: number
  rows: number
  /** Handoff primer waiting to be typed once the agent shows its first prompt. */
  pendingPrimer?: string
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
  // Set when session metadata that must survive restart changes (e.g. a prompt
  // stamps lastPromptAt); flushed to disk on the tick so we don't writeFile on
  // every keystroke.
  private persistDirty = false
  // Detects autopilot from each agent's own state: Claude Code's acceptEdits from
  // its transcript; Copilot's "autopilot" mode from its session event log.
  private readonly autopilot = new AutopilotWatcher()
  private readonly copilotAutopilot = new CopilotAutopilotWatcher()
  private autopilotTick = 0
  // Set during shutdown so PTY exit handlers don't overwrite the saved session
  // list with an empty one (which would defeat resume-on-next-launch).
  private disposing = false
  // Pending batches from restore(), so shutdown can cancel them instead of
  // spawning agents into a tearing-down app.
  private readonly restoreTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly store: Store,
    private readonly recorder?: TranscriptRecorder,
    /** Dir holding the materialized crew-hook shell-integration scripts. */
    private readonly crewHookDir?: string
  ) {
    super()
  }

  roster(): SessionInfo[] {
    return [...this.sessions.values()].map((m) => ({ ...m.info }))
  }

  create(
    req: CreateSessionRequest,
    restore?: { id?: string; agentSessionId?: string; priorSessionId?: string; characterId?: string; color?: string; extraArgs?: string[]; tag?: string; sets?: string[]; workspaceIds?: string[]; description?: string; createdAt?: number; lastPromptAt?: number }
  ): SessionInfo {
    const preset = getPreset(req.presetId)
    const command = req.command || preset?.command || defaultShell()
    const args = req.args && req.args.length ? req.args : preset?.args ?? []
    const cwd = req.cwd || homedir() || process.cwd()
    const id = restore?.id ?? randomUUID()
    // The agent's own session UUID: reused when resuming (so we reattach the same
    // conversation), freshly minted otherwise. Passed via the preset's
    // sessionIdFlag (e.g. Copilot's --session-id=).
    const agentSessionId = restore?.agentSessionId ?? randomUUID()
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
      // Enhanced Terminal: install OSC 133 shell integration for the Shell
      // preset so command blocks / jump-to-prompt / exit-code marks work. Opt-in
      // (the setting is off by default) and only for a real zsh/bash shell;
      // agents, custom commands, and other shells are left completely untouched.
      const hook =
        this.store.settings.enhancedTerminal && req.presetId === 'shell' && this.crewHookDir
          ? crewHookFor(command, this.crewHookDir)
          : null
      const spawnArgs = [...args, ...idArgs, ...resumeExtra, ...(hook?.extraArgs ?? [])]
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
      this.sessions.set(id, { info, proc: null, detector: null, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
      this.store.setAssignment(key, { characterId, lastLabel: label })
      this.emitRoster()
      const message = err instanceof Error ? err.message : String(err)
      this.emit('output', { id, data: `\r\n\x1b[31mFailed to launch \x1b[1m${command}\x1b[0m\x1b[31m: ${message}\x1b[0m\r\n` })
      return { ...info }
    }

    info.pid = proc.pid
    const detector = new StateDetector(now, cfg, (state, reason) => this.onState(id, state, reason))
    const managed: Managed = { info, proc, detector, cost, credits, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
    // A session superseding an older conversation carries its brief instead of
    // the transcript. Hold the primer until the agent is actually at a prompt —
    // typing into a TUI that hasn't drawn one yet just loses the keystrokes.
    const brief = briefPathFor(restore?.priorSessionId)
    if (brief) managed.pendingPrimer = primerFor(brief)
    this.sessions.set(id, managed)
    this.store.setAssignment(key, { characterId, lastLabel: label })

    proc.onData((data) => {
      // Ignore any final flush that arrives after the session was closed/removed
      // (prevents resurrecting a disposed renderer terminal).
      if (!this.sessions.has(id)) return
      this.emit('output', { id, data })
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
    // Capture the freshest state (e.g. a lastPromptAt stamped since the last
    // persist-triggering action) while sessions are still active — before we
    // freeze persistence and kill the procs.
    this.persistSessions()
    // Freeze persistence first: the kills below fire onExit handlers that would
    // otherwise save an empty session list and wipe the resume state.
    this.disposing = true
    // Cancel any restore batches still queued, so shutdown doesn't spawn fresh
    // agents into a tearing-down app.
    for (const t of this.restoreTimers) clearTimeout(t)
    this.restoreTimers.clear()
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
   * 'transcript' reattaches the original conversation, so the agent replays its
   * log. 'brief' deliberately does not: it starts a fresh agent and seeds it
   * with the distilled handoff instead, which is the only way a session whose
   * log has outgrown the context window can come back at all.
   *
   * Either way the original conversation id survives — as agentSessionId when
   * reattaching, as priorSessionId when superseding — so a relaunch can never
   * orphan a transcript. That matters even with resume switched off, where the
   * id used to be dropped and then overwritten by the next persist.
   */
  private contextFor(
    agentSessionId: string | undefined,
    presetId: string | null
  ): { agentSessionId?: string; priorSessionId?: string; extraArgs: string[] } {
    return resolveContext({
      agentSessionId,
      resume: this.store.settings.resumeConversations,
      contextMode: this.store.settings.contextMode,
      resumeArgs: getPreset(presetId)?.resumeArgs
    })
  }

  /**
   * Re-launch the sessions saved from a previous run. A live agent process can't
   * literally be frozen, so this restores the workspace layout — same agent, cwd,
   * label and character — by spawning each session fresh. Call once on startup.
   *
   * Spawns in small batches rather than all at once. Every session brings up a
   * PTY that immediately streams its agent's boot output into its own terminal
   * engine; doing that for a whole roster in a single tick pegs the renderer and
   * makes the entire window flicker while it catches up — and the bigger the
   * roster, the longer it lasts. Batching keeps the UI responsive and lets the
   * roster fill in visibly instead of freezing until it's done.
   *
   * Returns the first batch synchronously; the rest arrive via roster events.
   */
  restore(): SessionInfo[] {
    const persisted = this.store.getSessions()
    const first = persisted.slice(0, RESTORE_BATCH).map((p) => this.restoreOne(p))
    const rest = persisted.slice(RESTORE_BATCH)
    if (rest.length) this.scheduleRestore(rest)
    return first
  }

  /** Spawn the next batch after a gap, then queue the one after it. */
  private scheduleRestore(queue: PersistedSession[]): void {
    const timer = setTimeout(() => {
      this.restoreTimers.delete(timer)
      if (this.disposing) return
      for (const p of queue.slice(0, RESTORE_BATCH)) {
        try {
          this.restoreOne(p)
        } catch (err) {
          // One session that can't be restored (e.g. its cwd is gone) must not
          // strand every session queued behind it.
          console.warn(
            `[crew] failed to restore session ${p.label}:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      this.emitRoster()
      const rest = queue.slice(RESTORE_BATCH)
      if (rest.length) this.scheduleRestore(rest)
    }, RESTORE_BATCH_GAP_MS)
    this.restoreTimers.add(timer)
  }

  private restoreOne(p: PersistedSession): SessionInfo {
    const ctx = this.contextFor(p.agentSessionId ?? p.priorSessionId, p.presetId)
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
        lastPromptAt: p.lastPromptAt
      }
    )
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
    return set.sessions.map((d) => {
      const ctx = this.contextFor(d.agentSessionId, d.presetId)
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
    // First time this agent offers a prompt, type the handoff primer in — but
    // never press Enter. The user reads it, and a restored roster of dozens of
    // sessions costs nothing until they choose to engage with one.
    if (m.pendingPrimer && (state === 'WAITING_INPUT' || state === 'IDLE')) {
      const primer = m.pendingPrimer
      m.pendingPrimer = undefined
      m.proc?.write(primer)
    }
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
      if (m.info.status !== 'active') continue
      let on: boolean
      if (isClaudeSession(m.info)) {
        // Claude Code: read the permission mode from its session transcript.
        on = this.autopilot.isAutopilot(m.info.id, m.info.cwd)
      } else if (isCopilotSession(m.info)) {
        // Copilot CLI: read the mode from its session.mode_changed event log.
        on = this.copilotAutopilot.isAutopilot(m.info.id, m.info.agentSessionId)
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
