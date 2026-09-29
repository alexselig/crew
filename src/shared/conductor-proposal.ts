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
   *  as escaped text, never as markup. Absent is normal, not an error, so the
   *  field is optional for any caller building a PlanProposal by hand. */
  narrative?: ProposalSection[]
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

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'unreadable' }
  }
  const candidate = raw as Record<string, unknown>
  if (!Array.isArray(candidate.rows)) return { ok: false, reason: 'unreadable' }

  const rows: ProposalRow[] = []
  for (const entry of candidate.rows) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    rows.push({
      roleName: typeof row.roleName === 'string' ? row.roleName : '',
      kind: row.kind === 'reviewer' ? 'reviewer' : 'author',
      presetId: typeof row.presetId === 'string' ? row.presetId : '',
      model: typeof row.model === 'string' && row.model ? row.model : null,
      rationale: typeof row.rationale === 'string' ? row.rationale : ''
    })
  }

  const narrative: ProposalSection[] = []
  if (Array.isArray(candidate.narrative)) {
    for (const entry of candidate.narrative) {
      if (typeof entry !== 'object' || entry === null) continue
      const section = entry as Record<string, unknown>
      const heading = typeof section.heading === 'string' ? section.heading : ''
      const sectionBody = typeof section.body === 'string' ? section.body : ''
      // A section with neither heading nor body renders as an empty band.
      if (!heading && !sectionBody) continue
      narrative.push({ heading, body: sectionBody })
    }
  }

  return {
    ok: true,
    proposal: {
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      narrative,
      rows
    }
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

  return { summary: proposal.summary, narrative: proposal.narrative ?? [], rows: reconciled, notes }
}
