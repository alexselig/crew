// An agent-written roster proposal is untrusted input. This module turns
// `.crew/conductor-plan.json` into rows the composer can show, and says
// plainly what it could not honour.

import type { RosterRow } from './conductor-composer'
import type { RoleKind } from './conductor'

export interface ProposalRow {
  roleName: string
  kind: RoleKind
  presetId: string
  model: string | null
  rationale: string
}

export interface ProposalSection {
  heading: string
  body: string
}

export interface PlanProposal {
  summary: string
  /** The conductor's argument for the plan. Plain text only — it is rendered
   *  as escaped text, never as markup. Empty is normal, not an error, but
   *  the field itself is always present: a proposal with no narrative still
   *  says so with `narrative: []`, rather than making every caller check
   *  for `undefined` on top of empty. */
  narrative: ProposalSection[]
  rows: ProposalRow[]
}

export type ParseResult =
  | { ok: true; proposal: PlanProposal }
  | { ok: false; reason: 'unreadable' }

export interface ProposalNote {
  /** Row index, or -1 for a note about the roster as a whole. */
  row: number
  severity: 'blocking' | 'warning'
  message: string
}

export interface ReconciledRoster {
  summary: string
  narrative: ProposalSection[]
  rows: (RosterRow & { rationale: string })[]
  notes: ProposalNote[]
}

/** Agents habitually wrap JSON in a fence even when told not to. */
function unfence(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  return (fenced ? fenced[1] : text).trim()
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNonEmptyString = (v: unknown): v is string => isString(v) && v.length > 0

// A JSON.parse result is ordinary data 99% of the time, but this boundary
// takes agent-written text, and nothing stops a hostile or buggy producer
// from handing back an object with a throwing getter or a Proxy instead.
// Every property read below is therefore treated as capable of throwing,
// the same guarded-inspection discipline describeEntryViolation uses in
// src/main/conductor-journal.ts (reimplemented here, not imported: shared
// code may never import from main).
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  // Object.keys is itself a property-inspecting call and can throw on an
  // exotic object; let the caller's try/catch convert that into "unreadable".
  return !Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))
}

/** Validates one proposed row. Returns the row or `undefined` for any
 *  violation — malformed rows are never coerced or skipped; the caller
 *  rejects the WHOLE proposal the moment any row comes back `undefined`. */
function readRow(entry: unknown): ProposalRow | undefined {
  try {
    if (!isPlainObject(entry)) return undefined
    if (!isNonEmptyString(entry.roleName)) return undefined
    if (entry.kind !== 'author' && entry.kind !== 'reviewer') return undefined
    if (!isNonEmptyString(entry.presetId)) return undefined
    if (entry.model !== null && !isNonEmptyString(entry.model)) return undefined
    if (!isString(entry.rationale)) return undefined
    return {
      roleName: entry.roleName,
      kind: entry.kind,
      presetId: entry.presetId,
      model: entry.model,
      rationale: entry.rationale
    }
  } catch {
    return undefined
  }
}

/** Validates one narrative section. A section is optional content, so an
 *  empty one is meaningful (renders as nothing) rather than malformed —
 *  but a section that is present must still be well-typed, never coerced. */
function readSection(entry: unknown): ProposalSection | undefined {
  try {
    if (!isPlainObject(entry)) return undefined
    if (!isString(entry.heading) || !isString(entry.body)) return undefined
    return { heading: entry.heading, body: entry.body }
  } catch {
    return undefined
  }
}

export function parseProposal(text: string): ParseResult {
  const body = unfence(text)
  if (!body) return { ok: false, reason: 'unreadable' }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    // A half-written file is the expected state while the agent is still
    // working, not an error worth surfacing.
    return { ok: false, reason: 'unreadable' }
  }

  try {
    if (!isPlainObject(raw)) return { ok: false, reason: 'unreadable' }
    const candidate = raw

    if (!isString(candidate.summary)) return { ok: false, reason: 'unreadable' }
    if (!Array.isArray(candidate.rows)) return { ok: false, reason: 'unreadable' }

    const rows: ProposalRow[] = []
    const seenRoleNames = new Set<string>()
    for (const entry of candidate.rows) {
      const row = readRow(entry)
      if (!row) return { ok: false, reason: 'unreadable' }
      // Two lanes with the same role name are not two lanes the user can
      // tell apart in the form, so this is as unreadable as a wrong type.
      if (seenRoleNames.has(row.roleName)) return { ok: false, reason: 'unreadable' }
      seenRoleNames.add(row.roleName)
      rows.push(row)
    }

    let narrative: ProposalSection[] = []
    if (candidate.narrative !== undefined) {
      if (!Array.isArray(candidate.narrative)) return { ok: false, reason: 'unreadable' }
      const sections: ProposalSection[] = []
      for (const entry of candidate.narrative) {
        const section = readSection(entry)
        if (!section) return { ok: false, reason: 'unreadable' }
        sections.push(section)
      }
      narrative = sections
    }

    return {
      ok: true,
      proposal: { summary: candidate.summary, narrative, rows }
    }
  } catch {
    // Inspecting `raw` itself threw (e.g. a throwing getter reached only
    // through a path not already guarded above).
    return { ok: false, reason: 'unreadable' }
  }
}

export function reconcileProposal(
  proposal: PlanProposal,
  reality: { models: string[]; presets: string[] },
  limits: { maxLanes: number }
): ReconciledRoster {
  const notes: ProposalNote[] = []

  let rows = proposal.rows
  if (rows.length > limits.maxLanes) {
    const dropped = rows.length - limits.maxLanes
    notes.push({
      row: -1,
      severity: 'warning',
      message: `proposed ${rows.length} lanes; at most ${limits.maxLanes} are allowed, so ${dropped} ${dropped === 1 ? 'was' : 'were'} dropped`
    })
    rows = rows.slice(0, limits.maxLanes)
  }

  const reconciled = rows.map((row, index) => {
    if (row.presetId && !reality.presets.includes(row.presetId)) {
      notes.push({
        row: index,
        severity: 'blocking',
        message: `${row.presetId} is not an installed agent — choose one`
      })
    }

    // Flagged, never substituted: picking a model on the user's behalf spends
    // their credits on something they did not choose and never saw.
    let model = row.model
    if (model && !reality.models.includes(model)) {
      notes.push({
        row: index,
        severity: 'blocking',
        message: `${model} is not an available model — choose one`
      })
      model = null
    }

    return {
      roleName: row.roleName,
      kind: row.kind,
      agent: { presetId: row.presetId, model },
      rationale: row.rationale
    }
  })

  return { summary: proposal.summary, narrative: proposal.narrative, rows: reconciled, notes }
}
