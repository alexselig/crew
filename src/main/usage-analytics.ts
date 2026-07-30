// usage-analytics.ts — read-only token-usage analytics for the Activity view.
// Reads the aggregate Copilot CLI history (~/.copilot/session-store.db, table
// assistant_usage_events) and buckets token throughput into five time ranges
// (past hour → past year), plus a per-repo/session "intensity" ranking.
//
// Read-only: only SELECTs via the system sqlite3 CLI (mode=ro), mirroring
// tracker.ts / week-review.ts. Never mutates the database.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageAnalytics, UsageBucket, UsageRangeData, UsageRangeKey, UsageSlice } from '../shared/usage'

const COPILOT_DB = join(homedir(), '.copilot', 'session-store.db')

const PROJECT_DENYLIST = new Set([
  '.copilot', '.claude', '.config', '.cache', '.git', 'tmp', 'node_modules',
  'Downloads', 'Desktop', 'Documents', 'Movies', 'Music', 'Pictures', 'Public',
  'Library', 'Applications', '.Trash'
])
const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\](.+)$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOUR = 3_600_000
const DAY = 86_400_000
const TOP_SLICES = 8

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function sqlite3Json(dbPath: string, query: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const uri = `file:${dbPath}?mode=ro`
    const attempt = (bin: string, fallback: (() => void) | null): void => {
      execFile(
        bin,
        ['-json', uri, query],
        { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' },
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

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

function projectOf(filePath: string | null): string | null {
  if (!filePath) return null
  const m = HOME_RE.exec(filePath)
  if (m) return m[1].split(/[/\\]/)[0] || null
  const parts = String(filePath).split(/[/\\]/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : null
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

function hourLabel(d: Date): string {
  const h = d.getHours()
  const am = h < 12
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${am ? 'a' : 'p'}`
}

// ── range specs ──────────────────────────────────────────────────────────────
// Each range knows its window, how many buckets, and how to (a) map an event's
// local Date to a bucket key and (b) enumerate its buckets with labels. Keys are
// strings so the same Map-based accumulation works for clock-aligned (hour/day)
// and calendar-aligned (week/month/year) buckets alike.

export interface RangeSpec {
  key: UsageRangeKey
  short: string
  title: string
  bucketLabel: string
  windowMs: number
  buckets: (now: Date) => { key: string; label: string }[]
  keyOf: (d: Date) => string
}

export const RANGES: RangeSpec[] = [
  {
    key: 'hour',
    short: '1h',
    title: 'Past hour',
    bucketLabel: '5-minute buckets',
    windowMs: HOUR,
    keyOf: (d) => String(Math.floor(d.getTime() / (5 * 60_000))),
    buckets: (now) => {
      const step = 5 * 60_000
      const last = Math.floor(now.getTime() / step)
      const out: { key: string; label: string }[] = []
      for (let i = 11; i >= 0; i--) {
        const start = (last - i) * step
        const d = new Date(start)
        out.push({ key: String(last - i), label: `${two(d.getHours())}:${two(d.getMinutes())}` })
      }
      return out
    }
  },
  {
    key: 'day',
    short: '24h',
    title: 'Past 24 hours',
    bucketLabel: 'hourly buckets',
    windowMs: DAY,
    keyOf: (d) => String(Math.floor(d.getTime() / HOUR)),
    buckets: (now) => {
      const last = Math.floor(now.getTime() / HOUR)
      const out: { key: string; label: string }[] = []
      for (let i = 23; i >= 0; i--) {
        const d = new Date((last - i) * HOUR)
        out.push({ key: String(last - i), label: hourLabel(d) })
      }
      return out
    }
  },
  {
    key: 'week',
    short: '7d',
    title: 'Past 7 days',
    bucketLabel: 'daily buckets',
    windowMs: 7 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    buckets: (now) => {
      const out: { key: string; label: string }[] = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, label: WEEKDAYS[d.getDay()] })
      }
      return out
    }
  },
  {
    key: 'month',
    short: '30d',
    title: 'Past 30 days',
    bucketLabel: 'daily buckets',
    windowMs: 30 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    buckets: (now) => {
      const out: { key: string; label: string }[] = []
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        // Label only week boundaries to avoid a cramped axis; others blank.
        const label = i % 5 === 0 || i === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : ''
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, label })
      }
      return out
    }
  },
  {
    key: 'year',
    short: '1y',
    title: 'Past 12 months',
    bucketLabel: 'monthly buckets',
    windowMs: 366 * DAY,
    keyOf: (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}`,
    buckets: (now) => {
      const out: { key: string; label: string }[] = []
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        out.push({ key: `${d.getFullYear()}-${two(d.getMonth() + 1)}`, label: MONTHS[d.getMonth()] })
      }
      return out
    }
  }
]

export interface UsageEvent {
  ms: number
  tokens: number
  aiu: number
  session: string
}

export function buildRange(spec: RangeSpec, events: UsageEvent[], now: Date, labelOf: (session: string) => UsageSlice): UsageRangeData {
  const defs = spec.buckets(now)
  const idx = new Map<string, number>()
  defs.forEach((b, i) => idx.set(b.key, i))
  const series: UsageBucket[] = defs.map((b) => ({ label: b.label, tokens: 0 }))

  const cutoff = now.getTime() - spec.windowMs
  let totalTokens = 0
  let totalAiu = 0
  const bySlice = new Map<string, UsageSlice>()
  // Per-slice bucket accumulators (name → tokens[] aligned to `defs`), so the
  // chart can be redrawn for a single project. Bounded: one array per distinct
  // slice name, trimmed below to just the surfaced `projects`.
  const bucketsBySlice = new Map<string, number[]>()

  for (const e of events) {
    if (e.ms < cutoff) continue
    const i = idx.get(spec.keyOf(new Date(e.ms)))
    if (i === undefined) continue
    series[i].tokens += e.tokens
    totalTokens += e.tokens
    totalAiu += e.aiu
    const slice = labelOf(e.session)
    const acc = bySlice.get(slice.name)
    if (acc) acc.tokens += e.tokens
    else bySlice.set(slice.name, { name: slice.name, tokens: e.tokens, kind: slice.kind })
    let arr = bucketsBySlice.get(slice.name)
    if (!arr) {
      arr = new Array(defs.length).fill(0)
      bucketsBySlice.set(slice.name, arr)
    }
    arr[i] += e.tokens
  }

  let peakLabel: string | null = null
  let peak = 0
  for (const b of series) {
    if (b.tokens > peak && b.label) {
      peak = b.tokens
      peakLabel = b.label
    }
  }

  const ranked = [...bySlice.values()].sort((a, b) => b.tokens - a.tokens)
  const projects = ranked.slice(0, TOP_SLICES)
  const topNames = new Set(projects.map((p) => p.name))
  if (ranked.length > TOP_SLICES) {
    const rest = ranked.slice(TOP_SLICES).reduce((a, s) => a + s.tokens, 0)
    if (rest > 0) projects.push({ name: 'Other', tokens: rest, kind: 'session' })
  }

  // Emit a per-project series for exactly the surfaced projects (top slices +
  // the aggregated "Other"), so the Activity chart can filter to one of them.
  const seriesByProject: Record<string, UsageBucket[]> = {}
  for (const p of projects) {
    if (p.name === 'Other' && !topNames.has('Other')) {
      const agg = new Array(defs.length).fill(0)
      for (const [name, arr] of bucketsBySlice) {
        if (topNames.has(name)) continue
        for (let i = 0; i < arr.length; i++) agg[i] += arr[i]
      }
      seriesByProject.Other = defs.map((b, i) => ({ label: b.label, tokens: agg[i] }))
    } else {
      const arr = bucketsBySlice.get(p.name) ?? new Array(defs.length).fill(0)
      seriesByProject[p.name] = defs.map((b, i) => ({ label: b.label, tokens: arr[i] }))
    }
  }

  return {
    key: spec.key,
    short: spec.short,
    title: spec.title,
    bucketLabel: spec.bucketLabel,
    series,
    totalTokens,
    totalAiu,
    peakLabel,
    projects,
    seriesByProject
  }
}

/**
 * Build token-usage analytics across five time ranges (past hour … past year),
 * each with an over-time token series and a per-repo/session intensity ranking.
 * Read-only.
 */
export async function buildUsageAnalytics(): Promise<UsageAnalytics> {
  const now = new Date()
  const empty: UsageAnalytics = { available: false, generatedAt: now.getTime(), ranges: [] }
  if (!(await exists(COPILOT_DB))) return empty

  // Look back a little over a year (the widest range) and let JS bucket precisely
  // in local time. The ISO cutoff compares cleanly against the ISO created_at.
  const cutoffISO = new Date(now.getTime() - 370 * DAY).toISOString()

  const [usageRows, fileRows, sessionRows] = await Promise.all([
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, created_at, ` +
        `COALESCE(input_tokens,0) + COALESCE(output_tokens,0) AS tok, ` +
        `COALESCE(total_nano_aiu,0) AS aiu ` +
        `FROM assistant_usage_events WHERE created_at >= '${cutoffISO}'`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT session_id, file_path FROM session_files ` +
        `WHERE session_id IN (SELECT id FROM sessions WHERE created_at >= '${cutoffISO}')`
    ),
    sqlite3Json(
      COPILOT_DB,
      `SELECT id, summary FROM sessions WHERE created_at >= '${cutoffISO}'`
    )
  ])

  if (usageRows.length === 0) return { available: true, generatedAt: now.getTime(), ranges: RANGES.map((s) => buildRange(s, [], now, () => ({ name: 'Other', tokens: 0, kind: 'session' }))) }

  // Primary repo per session (most-touched, denylist-filtered).
  const repoCounts = new Map<string, Map<string, number>>()
  for (const r of fileRows) {
    const sid = str(r.session_id)
    const proj = projectOf(str(r.file_path))
    if (!proj || PROJECT_DENYLIST.has(proj)) continue
    if (!repoCounts.has(sid)) repoCounts.set(sid, new Map())
    const per = repoCounts.get(sid) as Map<string, number>
    per.set(proj, (per.get(proj) || 0) + 1)
  }
  const repoOf = new Map<string, string>()
  for (const [sid, per] of repoCounts) {
    let best: string | null = null
    let n = -1
    for (const [name, c] of per) {
      if (c > n) {
        n = c
        best = name
      }
    }
    if (best) repoOf.set(sid, best)
  }
  const summaryOf = new Map<string, string>()
  for (const r of sessionRows) {
    const s = str(r.summary).trim()
    if (s) summaryOf.set(str(r.id), s)
  }

  // A slice is the session's repo when it touched one, else its summary — literal
  // "intensity by git repo or session". Memoized so equal names merge cleanly.
  const sliceCache = new Map<string, UsageSlice>()
  const labelOf = (session: string): UsageSlice => {
    const cached = sliceCache.get(session)
    if (cached) return cached
    const repo = repoOf.get(session)
    const slice: UsageSlice = repo
      ? { name: repo, tokens: 0, kind: 'repo' }
      : { name: summaryOf.get(session) || 'Untitled session', tokens: 0, kind: 'session' }
    sliceCache.set(session, slice)
    return slice
  }

  const events: UsageEvent[] = []
  for (const r of usageRows) {
    const ms = Date.parse(str(r.created_at))
    if (Number.isNaN(ms)) continue
    events.push({ ms, tokens: num(r.tok), aiu: num(r.aiu), session: str(r.session_id) })
  }

  return {
    available: true,
    generatedAt: now.getTime(),
    ranges: RANGES.map((spec) => buildRange(spec, events, now, labelOf))
  }
}
