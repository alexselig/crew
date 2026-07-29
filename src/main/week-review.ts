// week-review.ts — a read-only "Past Week" summary derived from the aggregate
// Copilot CLI history at ~/.copilot/session-store.db. This is a trimmed in-app
// port of the standalone week-in-review dashboard (server/{copilotStore,review,
// week,followups}.js), scoped to the parts that fit the Project Tracker:
// day-by-day activity, projects touched, stats, and follow-up suggestions.
//
// It NEVER mutates the database — only read-only SELECTs, run via the system
// sqlite3 CLI (mode=ro), the same pattern tracker.ts uses. Sessions are windowed
// to the trailing 7 local days.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  PastWeek,
  PastWeekDay,
  PastWeekFollowup,
  PastWeekProject,
  PastWeekSession
} from '../shared/tracker'

const COPILOT_DB = join(homedir(), '.copilot', 'session-store.db')

// Directories that are tooling/noise rather than real "projects".
const PROJECT_DENYLIST = new Set([
  '.copilot', '.claude', '.config', '.cache', '.git', 'tmp', 'node_modules',
  'Downloads', 'Desktop', 'Documents', 'Movies', 'Music', 'Pictures', 'Public',
  'Library', 'Applications', '.Trash'
])
const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\](.+)$/
const MAX_FOLLOWUPS = 30
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

// Read-only JSON query via the system sqlite3 CLI (mode=ro, so no write lock on
// the live WAL db). Timeout + SIGKILL so a wedged db can't hang; failure → [].
function sqlite3Json(dbPath: string, query: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const uri = `file:${dbPath}?mode=ro`
    const attempt = (bin: string, fallback: (() => void) | null): void => {
      execFile(
        bin,
        ['-json', uri, query],
        { encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' },
        (err, stdout) => {
          if (err) {
            if (fallback) fallback()
            else resolve([])
            return
          }
          try {
            const j = JSON.parse(String(stdout || '[]'))
            resolve(Array.isArray(j) ? (j as Array<Record<string, unknown>>) : [])
          } catch {
            resolve([])
          }
        }
      )
    }
    attempt('/usr/bin/sqlite3', () => attempt('sqlite3', null))
  })
}

// ── date helpers (local-timezone day bucketing of UTC-stored timestamps) ─────

function fmtLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Normalize a stored timestamp ("...T...Z" or "YYYY-MM-DD HH:MM:SS" UTC). */
function toDate(ts: unknown): Date | null {
  if (ts == null) return null
  let s = String(ts).trim()
  if (!s) return null
  if (!s.includes('T')) {
    s = s.replace(' ', 'T')
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function timeLabel(ts: unknown): string {
  const d = toDate(ts)
  if (!d) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${WEEKDAYS[dt.getDay()]} ${MONTHS[dt.getMonth()]} ${dt.getDate()}`
}

function rangeLabel(from: Date, to: Date): string {
  const sameYear = from.getFullYear() === to.getFullYear()
  const sameMonth = sameYear && from.getMonth() === to.getMonth()
  const s = `${MONTHS[from.getMonth()]} ${from.getDate()}`
  if (sameMonth) return `${s} – ${to.getDate()}, ${to.getFullYear()}`
  if (sameYear) return `${s} – ${MONTHS[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`
  return `${s}, ${from.getFullYear()} – ${MONTHS[to.getMonth()]} ${to.getDate()}, ${to.getFullYear()}`
}

/** Best-effort "project" name for a touched file path. */
function projectOf(filePath: string | null): string | null {
  if (!filePath) return null
  const m = HOME_RE.exec(filePath)
  if (m) return m[1].split(/[/\\]/)[0] || null
  const parts = String(filePath).split(/[/\\]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : null
}

// ── follow-up extraction (port of server/followups.js) ───────────────────────

const LIST_MARKER = /^\s*(?:\d{1,3}[.)]|[-*•·])\s+/
const LEADING_ENUM = /^\s*(?:\*\*)?\s*(?:\d{1,3}[.)]|[-*•·])\s*(?:\*\*)?\s*/
const IMPERATIVE = new Set([
  'add', 'fix', 'update', 'remove', 'confirm', 'review', 'check', 'verify',
  'implement', 'test', 'write', 'create', 'refactor', 'decide', 'finalize',
  'finish', 'ship', 'deploy', 'investigate', 'wire', 'build', 'rename',
  'move', 'delete', 'document', 'ensure', 'handle', 'run', 'send', 'follow',
  'schedule', 'email', 'ask', 'draft', 'prepare'
])

function stripMarkdown(line: string): string {
  return line
    .replace(/`+/g, '')
    .replace(/\*\*/g, '')
    .replace(/(^|\s)[_*]([^_*]+)[_*](?=\s|$)/g, '$1$2')
    .replace(/^#+\s*/, '')
}

function extractFollowups(text: string | null): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const isList = LIST_MARKER.test(line)
    let cleaned = stripMarkdown(isList ? line.replace(LEADING_ENUM, '') : line).replace(/\s+/g, ' ').trim()
    if (!cleaned) continue
    const isHeading = !isList && /:$/.test(cleaned) && !/[.?!]/.test(cleaned.slice(0, -1))
    if (isHeading) continue
    const first = cleaned.split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!isList && !IMPERATIVE.has(first)) continue
    cleaned = cleaned.replace(/:$/, '').trim()
    if (cleaned.length < 4) continue
    if (cleaned.length > 200) cleaned = cleaned.slice(0, 199).trimEnd() + '…'
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }
  return out
}

/** Tiny stable id for a follow-up (djb2 hash → base36). */
function hashId(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

/**
 * Build the Past Week summary: sessions from the trailing 7 local days, bucketed
 * by day, with per-day session titles/projects, the projects touched, stats, and
 * follow-up suggestions from checkpoint next-steps. Read-only.
 */
export async function buildPastWeek(): Promise<PastWeek> {
  const empty: PastWeek = {
    available: false,
    weekStart: '',
    rangeLabel: '',
    stats: { sessions: 0, activeDays: 0, projects: 0, messages: 0, tokens: 0, topModel: null },
    days: [],
    projects: [],
    followups: []
  }
  if (!(await exists(COPILOT_DB))) return empty

  // Trailing 7 local days [today-6 .. today]. Query a ±1 day UTC cushion, then
  // bucket precisely by local day.
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = new Date(today)
  from.setDate(from.getDate() - 6)
  const fromKey = fmtLocal(from)
  const toKey = fmtLocal(today)
  const cushLo = new Date(from)
  cushLo.setDate(cushLo.getDate() - 1)
  const cushHi = new Date(today)
  cushHi.setDate(cushHi.getDate() + 1)
  const fromDayUTC = cushLo.toISOString().slice(0, 10)
  const toDayUTC = cushHi.toISOString().slice(0, 10)

  const inWindow =
    `IN (SELECT id FROM sessions WHERE substr(created_at,1,10) BETWEEN '${fromDayUTC}' AND '${toDayUTC}')`

  const [sessionRows, turnRows, fileRows, cpRows, usageRows, usageBySessionRows] = await Promise.all([
    sqlite3Json(
      COPILOT_DB,
      `SELECT id, summary, created_at FROM sessions ` +
        `WHERE substr(created_at,1,10) BETWEEN '${fromDayUTC}' AND '${toDayUTC}' ORDER BY created_at ASC`
    ),
    sqlite3Json(COPILOT_DB, `SELECT session_id, COUNT(*) AS n FROM turns WHERE session_id ${inWindow} GROUP BY session_id`),
    sqlite3Json(COPILOT_DB, `SELECT session_id, file_path FROM session_files WHERE session_id ${inWindow}`),
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, next_steps FROM checkpoints WHERE session_id ${inWindow} ORDER BY checkpoint_number ASC`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT model, COUNT(*) AS calls FROM assistant_usage_events WHERE session_id ${inWindow} GROUP BY model`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, COALESCE(SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)),0) AS tok ` +
        `FROM assistant_usage_events WHERE session_id ${inWindow} GROUP BY session_id`
    )
  ])

  // Keep only sessions whose LOCAL day falls in the window.
  const sessions = sessionRows
    .map((r) => ({ id: str(r.id), summary: str(r.summary), created_at: str(r.created_at) }))
    .filter((s) => {
      const d = toDate(s.created_at)
      if (!d) return false
      const key = fmtLocal(d)
      return key >= fromKey && key <= toKey
    })
  const keep = new Set(sessions.map((s) => s.id))

  const turns = new Map<string, number>()
  for (const r of turnRows) turns.set(str(r.session_id), num(r.n))

  const tokensBySession = new Map<string, number>()
  for (const r of usageBySessionRows) tokensBySession.set(str(r.session_id), num(r.tok))

  // Project attribution from touched files.
  const filesBySession = new Map<string, Map<string, number>>()
  const projectAgg = new Map<string, { name: string; sessions: Set<string>; files: number }>()
  for (const r of fileRows) {
    const sid = str(r.session_id)
    if (!keep.has(sid)) continue
    const proj = projectOf(str(r.file_path))
    if (!proj || PROJECT_DENYLIST.has(proj)) continue
    if (!filesBySession.has(sid)) filesBySession.set(sid, new Map())
    const per = filesBySession.get(sid) as Map<string, number>
    per.set(proj, (per.get(proj) || 0) + 1)
    if (!projectAgg.has(proj)) projectAgg.set(proj, { name: proj, sessions: new Set(), files: 0 })
    const agg = projectAgg.get(proj) as { name: string; sessions: Set<string>; files: number }
    agg.sessions.add(sid)
    agg.files += 1
  }

  const projects: PastWeekProject[] = [...projectAgg.values()]
    .map((p) => ({
      name: p.name,
      sessions: p.sessions.size,
      files: p.files,
      tokens: [...p.sessions].reduce((a, sid) => a + (tokensBySession.get(sid) || 0), 0)
    }))
    .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions || b.files - a.files || a.name.localeCompare(b.name))

  // Sessions bucketed by local day. Enrich each with its turns, top projects and
  // a display title first, then drop pure-noise blank launches (no summary, no
  // messages, no touched project) so both the timeline and the stats stay honest.
  const sessionTitle = new Map<string, string>()
  const enriched = sessions
    .map((s) => {
      const per = filesBySession.get(s.id)
      const topProjects = per
        ? [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name)
        : []
      const t = turns.get(s.id) || 0
      const hasSummary = !!(s.summary && s.summary.trim())
      const title = hasSummary
        ? (s.summary as string).trim()
        : topProjects.length
          ? `Worked in ${topProjects[0]}`
          : 'Untitled session'
      return { s, topProjects, turns: t, title, noise: !hasSummary && t === 0 && topProjects.length === 0 }
    })
    .filter((e) => !e.noise)

  const byDay = new Map<string, PastWeekSession[]>()
  for (const e of enriched) {
    sessionTitle.set(e.s.id, e.title)
    const d = toDate(e.s.created_at) as Date
    const key = fmtLocal(d)
    if (!byDay.has(key)) byDay.set(key, [])
    ;(byDay.get(key) as PastWeekSession[]).push({
      id: e.s.id,
      time: timeLabel(e.s.created_at),
      title: e.title,
      projects: e.topProjects,
      turns: e.turns,
      tokens: tokensBySession.get(e.s.id) || 0
    })
  }

  const days: PastWeekDay[] = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // newest day first
    .map(([date, list]) => ({ date, label: dayLabel(date), sessions: list }))

  // Follow-up suggestions from checkpoint next_steps.
  const followups: PastWeekFollowup[] = []
  const seenSug = new Set<string>()
  for (const cp of cpRows) {
    const sid = str(cp.session_id)
    if (!keep.has(sid)) continue
    for (const text of extractFollowups(str(cp.next_steps) || null)) {
      const id = hashId(`${sid}|${text}`)
      if (seenSug.has(id)) continue
      seenSug.add(id)
      followups.push({ id, text, sessionTitle: sessionTitle.get(sid) || 'session' })
      if (followups.length >= MAX_FOLLOWUPS) break
    }
    if (followups.length >= MAX_FOLLOWUPS) break
  }

  // Usage / stats. "Tokens" is total processed (input + output) across the week's
  // displayed sessions; topModel is whichever model ran the most calls.
  let topModel: string | null = null
  let bestCalls = -1
  for (const r of usageRows) {
    const calls = num(r.calls)
    if (calls > bestCalls) {
      bestCalls = calls
      topModel = str(r.model) || null
    }
  }

  let tokens = 0
  for (const e of enriched) tokens += tokensBySession.get(e.s.id) || 0

  let messages = 0
  for (const e of enriched) messages += e.turns

  return {
    available: true,
    weekStart: fromKey,
    rangeLabel: rangeLabel(from, today),
    stats: {
      sessions: enriched.length,
      activeDays: days.length,
      projects: projects.length,
      messages,
      tokens,
      topModel
    },
    days,
    projects,
    followups
  }
}
