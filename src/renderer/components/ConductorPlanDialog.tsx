// The plan view: renders a `ReconciledRoster` as a document you read before
// you decide to act on it. Every value here is agent-written and untrusted —
// see src/shared/conductor-proposal.ts — so this component NEVER interprets
// any of it as markup. It is rendered as React text nodes only, exactly like
// conductor-plan-document.ts promises: no HTML-interpreting render path, ever.
//
// A ReconciledRoster carries no repo path or integration branch (Task 12
// never asked the agent for either, since neither is something an agent
// should choose for the user). That means this screen can never itself
// finish a run: there is no repo to build a valid RosterDraft from. So
// there is exactly ONE action here, honestly labelled "Continue" (not
// "Create" — it does not create anything), which opens ConductorComposer
// pre-filled from the proposal. The composer's own submit — where the user
// has supplied a repo — is the only place a run is actually created, and
// the only place validateRoster gets to say no.
//
// Continue is never disabled by a blocking note. The composer is exactly
// where a blocked proposal — a stale preset, an unavailable model, a
// duplicate role name — gets fixed, so refusing to open it over the very
// problems it exists to fix would leave the user with nowhere to go. The
// blocking notes stay visible in the document (rosterNotes / row.problems)
// the whole time the composer is open beneath it.
//
// The plan document itself stays on screen the whole time: continuing
// swaps the action bar for the composer beneath it, it never replaces the
// document. Losing the very thing the user was just reading, mid-decision,
// would defeat the point of showing it at all.
import { useMemo, useState } from 'react'
import type { Preset } from '../../shared/types'
import type { ReconciledRoster } from '../../shared/conductor-proposal'
import type { RosterDraft, ComposeResult } from '../../shared/conductor-composer'
import { buildPlanDocument, planDialogAction } from '../conductor-plan-document'
import { ConductorComposer } from './ConductorComposer'

interface Props {
  roster: ReconciledRoster
  presets: Preset[]
  maxLanes: number
  onCompose: (draft: RosterDraft) => Promise<ComposeResult>
  onCancel: () => void
}

export function ConductorPlanDialog({ roster, presets, maxLanes, onCompose, onCancel }: Props): JSX.Element {
  const doc = useMemo(() => buildPlanDocument(roster), [roster])
  const [continuing, setContinuing] = useState(false)
  const action = planDialogAction()

  return (
    <div className="plan-doc" role="dialog" aria-label="Proposed plan">
      {doc.bands.map((band, i) => (
        <section key={i} className={`plan-doc__band plan-doc__band--${band.kind}`}>
          {band.heading && <h2 className="plan-doc__heading">{band.heading}</h2>}
          {band.paragraphs.map((p, j) => (
            <p key={j} className="plan-doc__p">{p}</p>
          ))}
        </section>
      ))}

      {doc.rosterNotes.length > 0 && (
        <ul className="plan-doc__notes">
          {doc.rosterNotes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}

      <table className="plan-doc__roster">
        <thead>
          <tr><th>Role</th><th>Kind</th><th>Agent</th><th>Model</th><th>Why</th></tr>
        </thead>
        <tbody>
          {doc.rows.map((row, i) => (
            <tr key={i} className={row.problems.length > 0 ? 'plan-doc__row--blocked' : undefined}>
              <td>{row.roleName}</td>
              <td>{row.kindLabel}</td>
              <td>{row.presetId}</td>
              <td>{row.modelLabel}</td>
              <td>
                {row.rationale}
                {row.problems.map((p, j) => <div key={j} className="plan-doc__problem">{p}</div>)}
                {row.warnings.map((w, j) => <div key={j} className="plan-doc__warning">{w}</div>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {continuing && (
        <div className="plan-doc__composer">
          <ConductorComposer
            presets={presets}
            maxLanes={maxLanes}
            initial={roster}
            onCancel={() => setContinuing(false)}
            onCompose={onCompose}
          />
        </div>
      )}

      {!continuing && (
        <div className="plan-doc__actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setContinuing(true)}
          >
            {action.label}
          </button>
        </div>
      )}
    </div>
  )
}
