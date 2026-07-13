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
/** Copilot's session.mode_changed events carry the new mode in `newMode`. */
const COPILOT_MODE_RE = /"session\.mode_changed"[^\n]*?"newMode":"([a-zA-Z]+)"/g

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
  COPILOT_MODE_RE.lastIndex = 0
  let last: string | null = null
  let m: RegExpExecArray | null
  while ((m = COPILOT_MODE_RE.exec(text)) !== null) last = m[1]
  return last
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

/** Read a byte range [start, end) of a file as utf8. */
function readRange(path: string, start: number, end: number): string {
  const len = end - start
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

interface CopilotCached {
  path: string
  /** Byte offset up to which we've already scanned this log. */
  offset: number
  mode: string | null
}

/**
 * Polls Copilot event logs to tell whether a session is on autopilot. Keyed by
 * Crew session id; resolves the log via the agent's session UUID.
 *
 * Copilot always launches interactive (Crew never passes --autopilot), so the
 * first time we see a session we assume "interactive" and remember the log's
 * current end offset WITHOUT scanning its (possibly 100MB+) history. Each later
 * poll reads only the bytes appended since last time and applies the newest
 * session.mode_changed found there — so a Shift+Tab is caught within ~1s at any
 * terminal width, and a resumed session correctly starts interactive again.
 */
export class CopilotAutopilotWatcher {
  private readonly cache = new Map<string, CopilotCached>()

  /** @param stateDir base dir for Copilot session state (override in tests). */
  constructor(private readonly stateDir: string = COPILOT_STATE_DIR) {}

  /** Current autopilot state for a Copilot session with the given agent UUID. */
  isAutopilot(sessionId: string, agentSessionId: string | undefined): boolean {
    if (!agentSessionId) return false
    const path = copilotEventsPath(agentSessionId, this.stateDir)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      // No log yet (session still starting) — interactive, don't cache.
      return false
    }
    const prev = this.cache.get(sessionId)
    if (!prev || prev.path !== path || size < prev.offset) {
      // First sight (or the log was truncated/rotated): assume the launch mode
      // and start watching from the current end — never scan the huge history.
      this.cache.set(sessionId, { path, offset: size, mode: 'interactive' })
      return false
    }
    if (size === prev.offset) return isCopilotAutopilotMode(prev.mode)
    // Scan only the newly-appended bytes for the latest mode change.
    const mode = latestCopilotMode(readRange(path, prev.offset, size)) ?? prev.mode
    this.cache.set(sessionId, { path, offset: size, mode })
    return isCopilotAutopilotMode(mode)
  }

  /** Drop cached state for a closed session. */
  forget(sessionId: string): void {
    this.cache.delete(sessionId)
  }
}
