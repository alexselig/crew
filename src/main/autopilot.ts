// Autopilot detection for Claude Code sessions.
//
// Claude Code records the active permission mode on every user message in its
// session transcript (~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl) as
// a top-level `"permissionMode":"…"` field. When the user flips into
// auto-accept-edits ("auto pilot", Shift+Tab) that value becomes `acceptEdits`
// (or `bypassPermissions`). We can't ask the PTY, so we poll the transcript:
// find the newest transcript in the project dir and read the last permissionMode
// out of its tail. The file signature (path+size+mtime) is cached so an
// unchanged transcript is never re-read.

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import type { SessionInfo } from '../shared/types'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
/** permissionMode values that mean the agent is acting autonomously. */
const AUTOPILOT_MODES = new Set(['acceptEdits', 'bypassPermissions'])
/** How much of the transcript tail to scan for the latest permissionMode. */
const TAIL_BYTES = 512 * 1024
const PERMISSION_MODE_RE = /"permissionMode":"([a-zA-Z]+)"/g

/** True for sessions launched as Claude Code (the only agent with these transcripts). */
export function isClaudeSession(info: Pick<SessionInfo, 'presetId' | 'command'>): boolean {
  return info.presetId === 'claude-code' || basename(info.command) === 'claude'
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
