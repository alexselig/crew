// A reconciled proposal, arranged for reading. Pure: no DOM, no React, no IO.
//
// Everything here is plain text. The conductor never supplies markup and this
// module never interprets any: a body containing HTML comes out as a literal
// paragraph string and React escapes it on render. That is the whole security
// posture of the plan view, and the test above is what holds it in place.

import type { ReconciledRoster } from '../shared/conductor-proposal'

export interface PlanDocumentBand {
  kind: 'summary' | 'section'
  heading: string
  paragraphs: string[]
}

export interface PlanDocumentRow {
  roleName: string
  kindLabel: 'Author' | 'Reviewer'
  presetId: string
  modelLabel: string
  rationale: string
  problems: string[]
  warnings: string[]
}

export interface PlanDocument {
  bands: PlanDocumentBand[]
  rows: PlanDocumentRow[]
  rosterNotes: string[]
  blockingCount: number
  canCreate: boolean
}

function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export function buildPlanDocument(roster: ReconciledRoster): PlanDocument {
  const bands: PlanDocumentBand[] = []

  const summary = paragraphs(roster.summary)
  if (summary.length > 0) {
    bands.push({ kind: 'summary', heading: 'The plan', paragraphs: summary })
  }

  for (const section of roster.narrative) {
    const body = paragraphs(section.body)
    if (body.length === 0 && !section.heading.trim()) continue
    bands.push({ kind: 'section', heading: section.heading.trim(), paragraphs: body })
  }

  const rows: PlanDocumentRow[] = roster.rows.map((row) => ({
    roleName: row.roleName,
    kindLabel: row.kind === 'reviewer' ? 'Reviewer' : 'Author',
    presetId: row.agent.presetId,
    // Never invent a model name here. A null model means the preset's own
    // default will be used, and saying so is the honest label.
    modelLabel: row.agent.model ?? 'default model',
    rationale: row.rationale,
    problems: [],
    warnings: []
  }))

  const rosterNotes: string[] = []
  let blockingCount = 0

  for (const note of roster.notes) {
    if (note.row === -1) {
      rosterNotes.push(note.message)
      if (note.severity === 'blocking') blockingCount += 1
      continue
    }
    const target = rows[note.row]
    // A note aimed past the end of the roster is stale, not fatal. Dropping it
    // is safe; counting it as blocking would wedge Create with no visible cause.
    if (!target) continue
    if (note.severity === 'blocking') {
      target.problems.push(note.message)
      blockingCount += 1
    } else {
      target.warnings.push(note.message)
    }
  }

  return { bands, rows, rosterNotes, blockingCount, canCreate: blockingCount === 0 }
}

/** Which section of the dialog is showing beneath the (always-visible) plan
 *  document: either the single action bar, or the composer the sole action
 *  hands off to. The document itself is never conditional on this — see
 *  ConductorPlanDialog.tsx, which renders `doc.bands`/`doc.rows` unconditionally
 *  and only swaps this one region. */
export interface PlanDialogLayout {
  showActions: boolean
  showComposer: boolean
}

export function planDialogLayout(continuing: boolean): PlanDialogLayout {
  return { showActions: !continuing, showComposer: continuing }
}

/** The dialog's action bar: Cancel plus exactly ONE forward action. There is
 *  no separate "edit" affordance that duplicates it — both a blocking-note
 *  roster and a clean one hand off to the same composer, because neither
 *  path can create anything from this screen alone (no repo/integrationBranch
 *  on a ReconciledRoster; see the file-header comment). The label never
 *  claims "Create": this action opens the composer, it does not create a run. */
export interface PlanDialogAction {
  label: string
  disabled: boolean
}

export function planDialogAction(doc: Pick<PlanDocument, 'canCreate' | 'blockingCount'>): PlanDialogAction {
  return { label: 'Continue', disabled: !doc.canCreate }
}
