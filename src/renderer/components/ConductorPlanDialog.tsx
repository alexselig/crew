// The plan view: renders a `ReconciledRoster` as a document you read before
// you decide to act on it. Every value here is agent-written and untrusted —
// see src/shared/conductor-proposal.ts — so this component NEVER interprets
// any of it as markup. It is rendered as React text nodes only, exactly like
// conductor-plan-document.ts promises: no HTML-interpreting render path, ever.
//
// A ReconciledRoster carries no repo path or integration branch (Task 12
// never asked the agent for either, since neither is something an agent
// should choose for the user). That means neither "Edit the roster" nor
// "Create" can finish a run from this screen alone: both hand off to
// ConductorComposer, pre-filled from the proposal, where the user supplies
// the repository and the composer's own submit performs the real creation.
// The two buttons differ only in framing — "Create" is disabled the moment
// a blocking note stands, stating the same rule the composer enforces in
// the place the user is already reading it.
import { useMemo, useState } from 'react'
import type { Preset } from '../../shared/types'
import type { ReconciledRoster } from '../../shared/conductor-proposal'
import type { RosterDraft, ComposeResult } from '../../shared/conductor-composer'
import { buildPlanDocument } from '../conductor-plan-document'
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
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <ConductorComposer
        presets={presets}
        maxLanes={maxLanes}
        initial={roster}
        onCancel={() => setEditing(false)}
        onCompose={onCompose}
      />
    )
  }

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

      <div className="plan-doc__actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn" onClick={() => setEditing(true)}>Edit the roster</button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!doc.canCreate}
          title={doc.canCreate ? undefined : `${doc.blockingCount} problem(s) must be resolved first`}
          onClick={() => setEditing(true)}
        >
          Create
        </button>
      </div>
    </div>
  )
}
