// The composer: the one place a conducted workspace comes into existence.
// Not part of the new-session dialog — conducting is a property of the
// workspace, not a per-session toggle (see task-11-brief.md).

import { Fragment, useEffect, useState } from 'react'
import type { Preset } from '../../shared/types'
import type { AgentStatus } from '../../shared/api'
import type { RoleKind } from '../../shared/conductor'
import { validateRoster, type RosterDraft, type RosterRow, type ComposeResult } from '../../shared/conductor-composer'
import {
  parseProposal,
  reconcileProposal,
  type ProposalNote,
  type ReconciledRoster
} from '../../shared/conductor-proposal'
import { invalidateProposalNotes, describeComposeFailure } from '../conductor-view-model'
import { DEFAULT_COPILOT_MODEL, type CopilotModelCatalog } from '../../shared/copilot-models'
import { defaultLaneAgent, getCopilotModelSelection } from '../new-session-model'
import {
  EMPTY_TEST_RECIPE_INPUT,
  testRecipeFromInput,
  type TestRecipeFormInput
} from '../conductor-test-recipe'

interface Props {
  presets: Preset[]
  maxLanes: number
  /** A roster already reconciled from an agent-written plan (see
   *  src/shared/conductor-proposal.ts). Absent, the composer behaves exactly
   *  as Task 11 built it — the agent-planned path is an accelerator, never
   *  a dependency of the manual one. */
  initial?: ReconciledRoster
  onCancel: () => void
  onCompose: (draft: RosterDraft) => Promise<ComposeResult>
}

interface DraftRow extends RosterRow {
  /** Stable React key, independent of roleName so renaming a row never
   *  remounts its picker mid-edit. */
  key: string
  /** Why a proposed row was chosen. Display only — editing a row never
   *  touches it, so it stays attached to the row it explains. Empty for a
   *  row the user added by hand. */
  rationale: string
}

function newRow(key: string, presetId: string): DraftRow {
  return { key, roleName: '', kind: 'author', agent: defaultLaneAgent(presetId), rationale: '' }
}

function draftRowsFromReconciled(rows: ReconciledRoster['rows']): DraftRow[] {
  return rows.map((row, index) => ({
    key: `plan-${index}`,
    roleName: row.roleName,
    kind: row.kind,
    agent: row.agent,
    rationale: row.rationale
  }))
}

function errorFor(errors: { field: string; message: string }[], field: string): string | undefined {
  return errors.find((e) => e.field === field)?.message
}

export function ConductorComposer({ presets, maxLanes, initial, onCancel, onCompose }: Props): JSX.Element {
  const [repo, setRepo] = useState('')
  const [integrationBranch, setIntegrationBranch] = useState('crew/integration')
  const [testRecipeInput, setTestRecipeInput] = useState<TestRecipeFormInput>(EMPTY_TEST_RECIPE_INPUT)
  const [rows, setRows] = useState<DraftRow[]>(
    () => initial ? draftRowsFromReconciled(initial.rows) : [newRow('row-0', presets[0]?.id ?? '')]
  )
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [catalog, setCatalog] = useState<CopilotModelCatalog | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [planSummary, setPlanSummary] = useState<string | null>(initial?.summary ?? null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [notes, setNotes] = useState<ProposalNote[]>(initial?.notes ?? [])

  // Reused from the session form: the same agent-availability list and the
  // same Copilot model catalogue, fetched the same way, so a row's picker
  // behaves identically to the one a plain session gets.
  useEffect(() => {
    void window.crew.detectAgents().then(setAgents)
  }, [])

  // presets can arrive after the first render (see NewSessionModal's own
  // fixup for the same reason); any row still carrying the placeholder empty
  // presetId is repointed at a real preset the moment one exists.
  useEffect(() => {
    if (!presets.length) return
    setRows((prev) => prev.map((r) => (
      presets.some((p) => p.id === r.agent.presetId)
        ? r
        : { ...r, agent: defaultLaneAgent(presets[0].id) }
    )))
  }, [presets])

  useEffect(() => {
    if (!rows.some((r) => r.agent.presetId === 'copilot-cli')) return
    let current = true
    void window.crew.listCopilotModels().then(
      (result) => { if (current) setCatalog(result) },
      (error: unknown) => {
        if (current) setCatalog({
          models: [], source: 'cli',
          error: `Could not load Copilot models: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    )
    return () => { current = false }
  }, [rows])

  const draft: RosterDraft = {
    repo,
    integrationBranch,
    rows: rows.map(({ key: _key, rationale: _rationale, ...row }) => row),
    test: testRecipeFromInput(testRecipeInput)
  }
  const validation = validateRoster(draft, { maxLanes })
  const hasBlockingNotes = notes.some((n) => n.severity === 'blocking')
  const canSubmit = validation.ok && !hasBlockingNotes

  // A note from the loaded plan describes one row as it stood the moment it
  // was reconciled. The instant the user touches that row by hand — edits,
  // removes, or adds one — the note may no longer describe anything real, so
  // it must not go on blocking Create for a problem the user already fixed
  // (see invalidateProposalNotes in conductor-view-model.ts).
  const updateRow = (key: string, patch: Partial<RosterRow>): void => {
    const index = rows.findIndex((r) => r.key === key)
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
    if (index !== -1) setNotes((prev) => invalidateProposalNotes(prev, { type: 'update', index }))
  }

  const addRow = (): void => {
    setRows((prev) => [...prev, newRow(`row-${Date.now()}`, presets[0]?.id ?? '')])
    setNotes((prev) => invalidateProposalNotes(prev, { type: 'add' }))
  }

  const removeRow = (key: string): void => {
    const index = rows.findIndex((r) => r.key === key)
    setRows((prev) => prev.filter((r) => r.key !== key))
    if (index !== -1) setNotes((prev) => invalidateProposalNotes(prev, { type: 'remove', index }))
  }

  // The Phase 1 way to exercise the whole agent-planned path with no agent
  // running: read a `.crew/conductor-plan.json` a user picks from disk and
  // reconcile it exactly as the (future) conductor session's output would be.
  const loadPlanFile = async (file: File): Promise<void> => {
    setPlanError(null)
    const text = await file.text()
    const parsed = parseProposal(text)
    if (!parsed.ok) {
      setPlanError('Could not read that plan file — it is not a well-formed proposal.')
      return
    }
    let models = catalog?.models ?? []
    try {
      const freshCatalog = await window.crew.listCopilotModels()
      setCatalog(freshCatalog)
      models = freshCatalog.models
    } catch {
      // Fall back to whatever the composer already knew about models; an
      // unavailable catalogue still lets presets and roster shape reconcile.
    }
    const result = reconcileProposal(
      parsed.proposal,
      { models, presets: presets.map((p) => p.id) },
      { maxLanes }
    )
    setPlanSummary(result.summary)
    setNotes(result.notes)
    setRows(draftRowsFromReconciled(result.rows))
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await onCompose(draft)
      setSubmitError(describeComposeFailure(result))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="conductor-composer" onSubmit={(e) => void submit(e)}>
      <h2>New conducted workspace</h2>

      <div className="conductor-composer-plan-loader">
        <label className="btn">
          Load a plan file…
          <input
            type="file"
            accept="application/json,.json"
            className="conductor-composer-plan-input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void loadPlanFile(file)
            }}
          />
        </label>
        {planError && <span className="conductor-composer-error">{planError}</span>}
      </div>

      {planSummary && <p className="conductor-composer-summary">{planSummary}</p>}
      {notes.filter((n) => n.row === -1).map((note, i) => (
        <p key={`note-${i}`} className={`conductor-composer-note conductor-composer-note--${note.severity}`}>
          {note.message}
        </p>
      ))}

      <label className="field">
        <span className="field__label">Repository</span>
        <input
          className="field__input"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="/path/to/repo"
        />
        {errorFor(validation.errors, 'repo') && (
          <span className="conductor-composer-error">{errorFor(validation.errors, 'repo')}</span>
        )}
      </label>

      <label className="field">
        <span className="field__label">Integration branch</span>
        <input
          className="field__input"
          value={integrationBranch}
          onChange={(e) => setIntegrationBranch(e.target.value)}
        />
        {errorFor(validation.errors, 'integrationBranch') && (
          <span className="conductor-composer-error">{errorFor(validation.errors, 'integrationBranch')}</span>
        )}
      </label>

      <fieldset className="conductor-composer-test-recipe">
        <legend>Test recipe (optional)</legend>
        <label className="field">
          <span className="field__label">Command</span>
          <input
            className="field__input"
            value={testRecipeInput.command}
            onChange={(e) => setTestRecipeInput((prev) => ({ ...prev, command: e.target.value }))}
            placeholder="npm test"
          />
        </label>
        <label className="field">
          <span className="field__label">Args</span>
          <input
            className="field__input"
            value={testRecipeInput.args}
            onChange={(e) => setTestRecipeInput((prev) => ({ ...prev, args: e.target.value }))}
            placeholder="run test --silent"
          />
        </label>
        <label className="field">
          <span className="field__label">Working directory</span>
          <input
            className="field__input"
            value={testRecipeInput.cwd}
            onChange={(e) => setTestRecipeInput((prev) => ({ ...prev, cwd: e.target.value }))}
            placeholder="."
          />
        </label>
        <label className="field">
          <span className="field__label">Timeout (ms)</span>
          <input
            className="field__input"
            value={testRecipeInput.timeoutMs}
            onChange={(e) => setTestRecipeInput((prev) => ({ ...prev, timeoutMs: e.target.value }))}
            placeholder="300000"
          />
        </label>
      </fieldset>

      <table className="conductor-composer-roster">
        <thead>
          <tr>
            <th>Role</th>
            <th>Kind</th>
            <th>Agent</th>
            <th>Model</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const rowNotes = notes.filter((n) => n.row === index)
            return (
              <Fragment key={row.key}>
                <RosterRowFields
                  row={row}
                  index={index}
                  presets={presets}
                  agents={agents}
                  catalog={catalog}
                  errors={validation.errors}
                  onChange={(patch) => updateRow(row.key, patch)}
                  onRemove={() => removeRow(row.key)}
                  removable={rows.length > 1}
                />
                {(row.rationale || rowNotes.length > 0) && (
                  <tr className="conductor-composer-row-details">
                    <td colSpan={5}>
                      {row.rationale && (
                        <p className="conductor-composer-rationale">{row.rationale}</p>
                      )}
                      {rowNotes.map((note, i) => (
                        <p
                          key={`row-note-${i}`}
                          className={`conductor-composer-note conductor-composer-note--${note.severity}`}
                        >
                          {note.message}
                        </p>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {errorFor(validation.errors, 'rows') && (
        <span className="conductor-composer-error">{errorFor(validation.errors, 'rows')}</span>
      )}

      <button type="button" className="btn" onClick={addRow}>＋ Add lane</button>

      {submitError && <p className="conductor-composer-error">{submitError}</p>}

      <div className="conductor-composer-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={!canSubmit || submitting}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  )
}

function RosterRowFields({
  row,
  index,
  presets,
  agents,
  catalog,
  errors,
  onChange,
  onRemove,
  removable
}: {
  row: DraftRow
  index: number
  presets: Preset[]
  agents: AgentStatus[]
  catalog: CopilotModelCatalog | null
  errors: { field: string; message: string }[]
  onChange: (patch: Partial<RosterRow>) => void
  onRemove: () => void
  removable: boolean
}): JSX.Element {
  const isCopilot = row.agent.presetId === 'copilot-cli'
  const modelSelection = getCopilotModelSelection(catalog, row.agent.model ?? DEFAULT_COPILOT_MODEL)
  const catalogModels = catalog?.models ?? []
  const roleNameError = errorFor(errors, `rows[${index}].roleName`)
  const modelError = errorFor(errors, `rows[${index}].agent.model`)
  const agentStatus = agents.find((a) => a.presetId === row.agent.presetId)

  return (
    <tr className="conductor-composer-row">
      <td>
        <input
          aria-label="Role name"
          value={row.roleName}
          onChange={(e) => onChange({ roleName: e.target.value })}
          placeholder="builder"
        />
        {roleNameError && <span className="conductor-composer-error">{roleNameError}</span>}
      </td>
      <td>
        <select
          aria-label="Role kind"
          value={row.kind}
          onChange={(e) => onChange({ kind: e.target.value as RoleKind })}
        >
          <option value="author">Author</option>
          <option value="reviewer">Reviewer</option>
        </select>
      </td>
      <td>
        <select
          aria-label="Agent"
          value={row.agent.presetId}
          onChange={(e) => onChange({ agent: defaultLaneAgent(e.target.value) })}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {agentStatus && !agentStatus.available && (
          <span className="agent-status agent-status--missing">
            ✗ <code>{agentStatus.command}</code> not found on PATH
          </span>
        )}
      </td>
      <td>
        {isCopilot && modelSelection.visible ? (
          <select
            aria-label="Model"
            value={row.agent.model ?? DEFAULT_COPILOT_MODEL}
            onChange={(e) => onChange({ agent: { ...row.agent, model: e.target.value } })}
          >
            {catalogModels.map((id) => (
              <option key={id} value={id}>
                {id === DEFAULT_COPILOT_MODEL ? 'GPT-6 Astra (default)' : id}
              </option>
            ))}
          </select>
        ) : (
          <span className="conductor-composer-no-model">—</span>
        )}
        {modelError && <span className="conductor-composer-error">{modelError}</span>}
      </td>
      <td>
        {removable && (
          <button type="button" className="btn" onClick={onRemove} aria-label="Remove lane">
            ✕
          </button>
        )}
      </td>
    </tr>
  )
}
