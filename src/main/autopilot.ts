// Autopilot detection for agent sessions.
//
// Claude Code records the active permission mode on every user message in its
// session transcript (~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl) as
// a top-level `"permissionMode":"…"` field. When the user flips into
// auto-accept-edits ("auto pilot", Shift+Tab) that value becomes `acceptEdits`
// (or `bypassPermissions`). We can't ask the PTY, so we poll the transcript:
// find the newest transcript in the project dir and read the last permissionMode
// out of its tail. The file signature (path+size+mtime) is cached so an
// unchanged transcript is never re-read.
//
// The GitHub Copilot CLI records mode changes authoritatively in its own event
// log: ~/.copilot/session-state/<agentSessionId>/events.jsonl gets a compact
// `{"type":"session.mode_changed",...,"newMode":"autopilot|interactive|plan"}`
// line every time you press Shift+Tab. Crew mints each session's id (via
// --session-id) so it knows this path exactly, and reads the last newMode out of
// the file tail — far more reliable than scraping the redrawn TUI footer (which
// truncates at narrow widths). "autopilot" is the only autonomous mode.

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { SessionInfo } from '../shared/types'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
/** Copilot per-session event logs live here, one dir per agentSessionId. */
const COPILOT_STATE_DIR = join(homedir(), '.copilot', 'session-state')
/** permissionMode values that mean the agent is acting autonomously. */
const AUTOPILOT_MODES = new Set(['acceptEdits', 'bypassPermissions'])
/** How much of the transcript tail to scan for the latest permissionMode. */
const TAIL_BYTES = 512 * 1024
const PERMISSION_MODE_RE = /"permissionMode":"([a-zA-Z]+)"/g
const COPILOT_MODES = new Set(['interactive', 'plan', 'autopilot'])
const MAX_MODE_RECORD_BYTES = 64 * 1024

/** True for sessions launched as Claude Code (the only agent with these transcripts). */
export function isClaudeSession(info: Pick<SessionInfo, 'presetId' | 'command'>): boolean {
  return info.presetId === 'claude-code' || basename(info.command) === 'claude'
}

/** True for GitHub Copilot CLI sessions. */
export function isCopilotSession(info: Pick<SessionInfo, 'presetId' | 'command'>): boolean {
  return info.presetId === 'copilot-cli' || basename(info.command) === 'copilot'
}

/** Path to a Copilot session's event log, given the agent's session UUID. */
export function copilotEventsPath(agentSessionId: string, baseDir: string = COPILOT_STATE_DIR): string {
  return join(baseDir, agentSessionId, 'events.jsonl')
}

/** The last `newMode` from session.mode_changed events in a chunk of log text, or null. */
export function latestCopilotMode(text: string): string | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const mode = copilotModeRecord(lines[i])
    if (mode) return mode
  }
  return null
}

function copilotModeRecord(line: string): string | null {
  if (!line.includes('session.mode_changed') || line.length > MAX_MODE_RECORD_BYTES) return null
  try {
    const event = JSON.parse(line)
    const mode = event?.data?.newMode
    return event?.type === 'session.mode_changed' && COPILOT_MODES.has(mode) ? mode : null
  } catch {
    // A torn or malformed JSONL record is not an authoritative mode change.
    return null
  }
}

/** True when a Copilot mode string means the agent runs autonomously. */
export function isCopilotAutopilotMode(mode: string | null): boolean {
  return mode === 'autopilot'
}

/**
 * Claude encodes a project's cwd into a directory name by replacing every
 * character that isn't [A-Za-z0-9] with `-` (e.g. `/Users/alex/app` →
 * `-Users-alex-app`).
 */
export function projectDirFor(cwd: string, projectsDir: string = PROJECTS_DIR): string {
  return join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

interface Transcript {
  path: string
  size: number
  mtimeMs: number
}

/** Newest `.jsonl` transcript in a project dir, or null when none/unreadable. */
function latestTranscript(dir: string): Transcript | null {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  let best: Transcript | null = null
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue
    try {
      const st = statSync(join(dir, f))
      if (!best || st.mtimeMs > best.mtimeMs) best = { path: join(dir, f), size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      /* file vanished between readdir and stat; skip */
    }
  }
  return best
}

/** Read up to the last TAIL_BYTES of a file as utf8 (whole file when smaller). */
function readTail(path: string, size: number): string {
  const start = Math.max(0, size - TAIL_BYTES)
  const len = size - start
  if (len <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(len)
    const read = readSync(fd, buf, 0, len, start)
    return buf.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}

/** The last permissionMode value in a chunk of transcript text, or null. */
export function latestPermissionMode(text: string): string | null {
  PERMISSION_MODE_RE.lastIndex = 0
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = PERMISSION_MODE_RE.exec(text)) !== null) last = m[1]
  return last
}

export function isAutopilotMode(mode: string | null): boolean {
  return mode != null && AUTOPILOT_MODES.has(mode)
}

interface Cached extends Transcript {
  mode: string | null
}

/**
 * Polls Claude transcripts to tell whether a session is on autopilot. One
 * instance per SessionManager; keyed by session id. Cheap to call on a timer:
 * a transcript is only re-read when its size/mtime change.
 */
export class AutopilotWatcher {
  private readonly cache = new Map<string, Cached>()

  /** @param projectsDir base dir for Claude transcripts (override in tests). */
  constructor(private readonly projectsDir: string = PROJECTS_DIR) {}

  /** Current autopilot state for a Claude session at `cwd`. */
  isAutopilot(sessionId: string, cwd: string): boolean {
    const latest = latestTranscript(projectDirFor(cwd, this.projectsDir))
    if (!latest) {
      this.cache.delete(sessionId)
      return false
    }
    const prev = this.cache.get(sessionId)
    if (prev && prev.path === latest.path && prev.size === latest.size && prev.mtimeMs === latest.mtimeMs) {
      return isAutopilotMode(prev.mode)
    }
    // Fall back to the previous mode if the tail happens to contain no user
    // message (e.g. a very long assistant turn) so we don't flip spuriously.
    const mode = latestPermissionMode(readTail(latest.path, latest.size)) ?? prev?.mode ?? null
    this.cache.set(sessionId, { ...latest, mode })
    return isAutopilotMode(mode)
  }

  /** Drop cached state for a closed session. */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}

async function readBlock(file: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(end - start)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset)
    if (!bytesRead) throw new Error('Copilot event log changed while reading; retrying next poll')
    offset += bytesRead
  }
  return buffer
}

interface CopilotCached {
  path: string
  ino: number
  dev: number
  mtimeMs: number
  offset: number
  mode: string | null
  pending: Buffer
  skipping: boolean
}

/**
 * Resume preserves Copilot's mode. Find the latest complete mode record on first
 * sight, then follow appends, retaining incomplete records between polls. Reads
 * are asynchronous and bounded so large agent/tool output cannot freeze the UI.
 */
export class CopilotAutopilotWatcher {
  private readonly cache = new Map<string, CopilotCached>()
  private readonly jobs = new Map<string, { path: string; result: Promise<boolean> }>()
  private readonly warned = new Set<string>()

  /** @param stateDir base dir for Copilot session state (override in tests). */
  constructor(private readonly stateDir: string = COPILOT_STATE_DIR) {}

  /** Current autopilot state for a Copilot session with the given agent UUID. */
  isAutopilot(sessionId: string, agentSessionId: string | undefined): Promise<boolean> {
    if (!agentSessionId) {
      this.forget(sessionId)
      return Promise.resolve(false)
    }
    const path = copilotEventsPath(agentSessionId, this.stateDir)
    const existing = this.jobs.get(sessionId)
    if (existing?.path === path) return existing.result
    const job = { path, result: Promise.resolve(false) }
    this.jobs.set(sessionId, job)
    const current = (): boolean => this.jobs.get(sessionId) === job
    job.result = this.refresh(sessionId, path, current).finally(() => {
      if (current()) this.jobs.delete(sessionId)
    })
    return job.result
  }

  private async refresh(sessionId: string, path: string, current: () => boolean): Promise<boolean> {
    const prev = this.cache.get(sessionId)
    let file: FileHandle | undefined
    try {
      file = await open(path, 'r')
      const st = await file.stat()
      const reset = !prev || prev.path !== path || prev.ino !== st.ino || prev.dev !== st.dev ||
        st.size < prev.offset || (st.size === prev.offset && st.mtimeMs !== prev.mtimeMs)
      let next: CopilotCached
      if (reset) {
        next = {
          path, ino: st.ino, dev: st.dev, mtimeMs: st.mtimeMs,
          offset: st.size, mode: null, pending: Buffer.alloc(0), skipping: false
        }
        await this.readInitial(file, next, current)
      } else {
        next = { ...prev, mtimeMs: st.mtimeMs }
        while (next.offset < st.size && current()) {
          const chunk = await readBlock(file, next.offset, Math.min(st.size, next.offset + TAIL_BYTES))
          this.consume(next, chunk)
          next.offset += chunk.length
        }
      }
      if (current()) {
        this.cache.set(sessionId, next)
        this.warned.delete(sessionId)
      }
      return isCopilotAutopilotMode(next.mode)
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      if (!missing && current() && !this.warned.has(sessionId)) {
        console.warn(`[autopilot] Cannot read mode for ${sessionId}; retaining last known state:`, error)
        this.warned.add(sessionId)
      }
      return prev?.path === path && isCopilotAutopilotMode(prev.mode)
    } finally {
      await file?.close()
    }
  }

  private async readInitial(file: FileHandle, state: CopilotCached, current: () => boolean): Promise<void> {
    let end = state.offset
    let suffix: Buffer = Buffer.alloc(0)
    let skipLast = true
    while (end > 0 && current()) {
      const start = Math.max(0, end - TAIL_BYTES)
      const block = await readBlock(file, start, end)
      if (end === state.offset) {
        const newline = block.lastIndexOf(10)
        const tail = block.subarray(newline + 1)
        state.skipping = tail.length > MAX_MODE_RECORD_BYTES || (start > 0 && newline === -1)
        state.pending = state.skipping ? Buffer.alloc(0) : Buffer.from(tail)
      }
      const data = Buffer.concat([block, suffix])
      let lineEnd = data.length
      for (let newline = data.lastIndexOf(10); newline >= 0; newline = data.lastIndexOf(10, newline - 1)) {
        if (!skipLast && lineEnd - newline <= MAX_MODE_RECORD_BYTES) {
          state.mode = copilotModeRecord(data.toString('utf8', newline + 1, lineEnd))
          if (state.mode) return
        }
        skipLast = false
        lineEnd = newline
        if (newline === 0) break
      }
      if (start === 0 && !skipLast && lineEnd <= MAX_MODE_RECORD_BYTES) {
        state.mode = copilotModeRecord(data.toString('utf8', 0, lineEnd))
      }
      suffix = lineEnd <= MAX_MODE_RECORD_BYTES ? Buffer.from(data.subarray(0, lineEnd)) : Buffer.alloc(0)
      skipLast ||= lineEnd > MAX_MODE_RECORD_BYTES
      end = start
    }
  }

  private consume(state: CopilotCached, chunk: Buffer): void {
    if (state.skipping) {
      const newline = chunk.indexOf(10)
      if (newline === -1) return
      chunk = chunk.subarray(newline + 1)
      state.skipping = false
    }
    const data = Buffer.concat([state.pending, chunk])
    let start = 0
    for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, start)) {
      if (newline - start <= MAX_MODE_RECORD_BYTES) {
        state.mode = copilotModeRecord(data.toString('utf8', start, newline)) ?? state.mode
      }
      start = newline + 1
    }
    state.skipping = data.length - start > MAX_MODE_RECORD_BYTES
    state.pending = state.skipping ? Buffer.alloc(0) : Buffer.from(data.subarray(start))
  }

  /** Drop cached state for a closed session. */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
    this.jobs.delete(sessionId)
    this.warned.delete(sessionId)
  }
}
