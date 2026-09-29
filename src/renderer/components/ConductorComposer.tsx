// The composer: the one place a conducted workspace comes into existence.
// Not part of the new-session dialog — conducting is a property of the
// workspace, not a per-session toggle (see task-11-brief.md).

import { useEffect, useState } from 'react'
import type { Preset } from '../../shared/types'
import type { AgentStatus } from '../../shared/api'
import type { RoleKind } from '../../shared/conductor'
import {
  validateRoster,
  type RosterDraft,
  type RosterRow,
  type ComposeResult
} from '../../shared/conductor-composer'
import { DEFAULT_COPILOT_MODEL, type CopilotModelCatalog } from '../../shared/copilot-models'
import { getCopilotModelSelection } from '../new-session-model'

interface Props {
  presets: Preset[]
  maxLanes: number
  onCancel: () => void
  onCompose: (draft: RosterDraft) => Promise<ComposeResult>
}

interface DraftRow extends RosterRow {
  /** Stable React key, independent of roleName so renaming a row never
   *  remounts its picker mid-edit. */
  key: string
}

function newRow(key: string, presetId: string): DraftRow {
  return { key, roleName: '', kind: 'author', agent: { presetId, model: null } }
}

function errorFor(errors: { field: string; message: string }[], field: string): string | undefined {
  return errors.find((e) => e.field === field)?.message
}

export function ConductorComposer({ presets, maxLanes, onCancel, onCompose }: Props): JSX.Element {
  const [repo, setRepo] = useState('')
  const [integrationBranch, setIntegrationBranch] = useState('crew/integration')
  const [rows, setRows] = useState<DraftRow[]>([newRow('row-0', presets[0]?.id ?? '')])
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [catalog, setCatalog] = useState<CopilotModelCatalog | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

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
        : { ...r, agent: { presetId: presets[0].id, model: presets[0].id === 'copilot-cli' ? DEFAULT_COPILOT_MODEL : null } }
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
    rows: rows.map(({ key: _key, ...row }) => row)
  }
  const validation = validateRoster(draft, { maxLanes })

  const updateRow = (key: string, patch: Partial<RosterRow>): void => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  const addRow = (): void => setRows((prev) => [...prev, newRow(`row-${Date.now()}`, presets[0]?.id ?? '')])
  const removeRow = (key: string): void => setRows((prev) => prev.filter((r) => r.key !== key))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!validation.ok || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const result = await onCompose(draft)
      if (!result.ok) {
        setSubmitError('message' in result ? result.message : 'could not create the run')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="conductor-composer" onSubmit={(e) => void submit(e)}>
      <h2>New conducted workspace</h2>

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
          {rows.map((row, index) => (
            <RosterRowFields
              key={row.key}
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
          ))}
        </tbody>
      </table>
      {errorFor(validation.errors, 'rows') && (
        <span className="conductor-composer-error">{errorFor(validation.errors, 'rows')}</span>
      )}

      <button type="button" className="btn" onClick={addRow}>＋ Add lane</button>

      {submitError && <p className="conductor-composer-error">{submitError}</p>}

      <div className="conductor-composer-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={!validation.ok || submitting}>
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
          onChange={(e) =>
            onChange({ agent: { presetId: e.target.value, model: e.target.value === 'copilot-cli' ? DEFAULT_COPILOT_MODEL : null } })
          }
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
