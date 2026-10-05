import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The events Crew is allowed to count. Anything not on this list is dropped.
 *
 * These exist because the backlog analysis behind CB-13..CB-19 had to be
 * reverse-engineered from two timestamps per session, and the questions that
 * mattered most — how long a session is actually worked in, how many prompts
 * it takes, which view is used, whether a session ended satisfied or abandoned
 * — were simply unanswerable.
 */
export const USAGE_EVENTS = [
  'session.created',
  'session.opened',
  'session.focused',
  'session.closed',
  'session.archived',
  'session.dwell',
  'session.prompt',
  'view.used',
  'agent.invoked',
  'conductor.invoked',
  'resume.offered',
  'resume.accepted',
  'resume.dismissed',
  'pty.failed'
] as const

export type UsageEvent = (typeof USAGE_EVENTS)[number]

/**
 * The only strings that may ever reach the log, per event. This is what makes
 * "never record prompt or terminal content" a property of the code rather than
 * a promise in a doc: there is no field anywhere that accepts free text, so a
 * caller cannot write a prompt into the log even deliberately.
 */
const VALUES: Partial<Record<UsageEvent, readonly string[]>> = {
  'view.used': ['grid', 'focus', 'columns', 'custom'],
  'session.closed': ['closed', 'exited', 'error'],
  'pty.failed': ['spawn', 'exit', 'write']
}

export interface UsageFields {
  /** A duration in milliseconds. */
  ms?: number
  /** A count. */
  n?: number
  /** One of the allow-listed values for this event. */
  v?: string
}

interface UsageRow {
  t: number
  e: UsageEvent
  ms?: number
  n?: number
  v?: string
}

export interface UsageSummary {
  events: number
  totals: Partial<Record<UsageEvent, number>>
  views: Record<string, number>
  dwellMs: number
  /** Milliseconds of the first recorded event, or null if there are none. */
  since: number | null
  /** Distinct calendar days the log covers. */
  days: number
}

/**
 * Opt-in, local-only usage insights: an append-only JSONL file in Crew's own
 * data directory that never leaves the machine.
 *
 * Off by default, and *silent* while off — it does not even create the file,
 * because an opt-in feature that still leaves artefacts on disk is not opt-in.
 * Crew has no analytics dependency today and this deliberately does not add
 * one: no network code appears in this file.
 */
export class UsageLog {
  readonly path: string
  private on: boolean

  constructor(path: string, opts: { enabled?: boolean } = {}) {
    this.path = path
    this.on = opts.enabled === true
  }

  get enabled(): boolean {
    return this.on
  }

  setEnabled(on: boolean): void {
    this.on = on === true
  }

  /** Count one thing. A no-op unless the user has opted in. */
  record(event: UsageEvent, fields: UsageFields = {}): void {
    if (!this.on) return
    const row = sanitize(event, fields)
    if (!row) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(row) + '\n')
    } catch {
      // Insights are never worth interrupting the user's work for.
    }
  }

  /** Delete the log. Consent is deliberately untouched: wiping is not opting out. */
  wipe(): void {
    try {
      rmSync(this.path, { force: true })
    } catch {
      /* best effort */
    }
  }

  /**
   * The numbers, computed on demand from the file so the panel always shows
   * what is actually on disk. Readable whether or not consent is currently on,
   * so a user who switches it off can still inspect and wipe what was kept.
   */
  summary(): UsageSummary {
    const rows = this.read()
    const totals: Partial<Record<UsageEvent, number>> = {}
    const views: Record<string, number> = {}
    const days = new Set<string>()
    let dwellMs = 0
    let since: number | null = null

    for (const r of rows) {
      totals[r.e] = (totals[r.e] ?? 0) + 1
      if (r.e === 'session.dwell' && typeof r.ms === 'number') dwellMs += r.ms
      if (r.e === 'view.used' && r.v) views[r.v] = (views[r.v] ?? 0) + 1
      if (typeof r.t === 'number') {
        days.add(new Date(r.t).toISOString().slice(0, 10))
        if (since === null || r.t < since) since = r.t
      }
    }

    return { events: rows.length, totals, views, dwellMs, since, days: days.size }
  }

  /** Every row, for an in-app "show me the raw log" view. */
  read(): UsageRow[] {
    if (!existsSync(this.path)) return []
    let raw = ''
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return []
    }
    const out: UsageRow[] = []
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line) as UsageRow
        // A truncated or hand-edited line must not cost the whole history.
        if (row && typeof row === 'object' && USAGE_EVENTS.includes(row.e)) out.push(row)
      } catch {
        /* skip */
      }
    }
    return out
  }
}

/** Build the row, keeping only fields that are known, typed and allow-listed. */
function sanitize(event: UsageEvent, fields: UsageFields): UsageRow | null {
  if (!USAGE_EVENTS.includes(event)) return null
  const row: UsageRow = { t: Date.now(), e: event }
  if (typeof fields.ms === 'number' && Number.isFinite(fields.ms)) row.ms = Math.round(fields.ms)
  if (typeof fields.n === 'number' && Number.isFinite(fields.n)) row.n = Math.round(fields.n)
  const allowed = VALUES[event]
  if (allowed && typeof fields.v === 'string' && allowed.includes(fields.v)) row.v = fields.v
  return row
}
