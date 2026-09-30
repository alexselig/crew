import { useCallback, useEffect, useState } from 'react'
import {
  buildRoster,
  conductorPanelMode,
  describeOutcome,
  describeUnexpectedFailure,
  type LaneRow
} from '../conductor-view-model'
import type { ConductorSnapshot } from '../../shared/conductor'

interface Props {
  /** Opens the composer for a brand-new conducted workspace (blank roster). */
  onNewWorkspace: () => void
  /** Opens the plan document view for an agent-written proposal file. */
  onLoadPlan: (file: File) => void
}

export function ConductorPanel({ onNewWorkspace, onLoadPlan }: Props): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ConductorSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.crew.getConductorState().then((state) => {
      if (!cancelled) setSnapshot(state)
    })
    const off = window.crew.onConductorState(setSnapshot)
    return () => {
      cancelled = true
      off()
    }
  }, [])

  // Both handlers refresh the snapshot straight from getConductorState() in
  // a `finally`, not only on the happy path — a rejected IPC call (transport
  // failure, never a structured refusal; see describeUnexpectedFailure) must
  // never leave the panel trusting a stale broadcast. Re-fetching the real,
  // current lock state is what stops a lane looking permanently "publishing"
  // after a rejection that no later broadcast ever corrected.
  const publish = useCallback(async (laneId: string) => {
    try {
      setMessage(describeOutcome(await window.crew.publishLane(laneId)))
    } catch (error) {
      setMessage(describeUnexpectedFailure('publish', error))
    } finally {
      void window.crew.getConductorState().then(setSnapshot)
    }
  }, [])

  const sync = useCallback(async (laneId: string) => {
    try {
      const outcome = await window.crew.syncLane(laneId)
      setMessage(outcome.ok ? 'Lane synced' : outcome.message)
    } catch (error) {
      setMessage(describeUnexpectedFailure('sync', error))
    } finally {
      void window.crew.getConductorState().then(setSnapshot)
    }
  }, [])

  const mode = conductorPanelMode(snapshot)
  if (mode === 'loading') return null

  if (mode === 'empty') {
    return (
      <section className="conductor conductor--empty">
        <button type="button" className="btn" onClick={onNewWorkspace}>
          New conducted workspace…
        </button>
        <label className="btn">
          Load a plan…
          <input
            type="file"
            accept="application/json,.json"
            className="conductor-plan-input"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) onLoadPlan(file)
            }}
          />
        </label>
      </section>
    )
  }

  // mode === 'active'
  const active = snapshot as ConductorSnapshot
  const rows = buildRoster(active)

  return (
    <section className="conductor">
      <header className="conductor-head">
        <h2>Conductor</h2>
        {active.needsAttention && (
          <span className="conductor-attention">
            An interrupted operation needs review
          </span>
        )}
      </header>
      <ul className="conductor-roster">
        {rows.map((row) => (
          <LaneRowView key={row.id} row={row} onPublish={publish} onSync={sync} />
        ))}
      </ul>
      {message && <p className="conductor-message">{message}</p>}
    </section>
  )
}

function LaneRowView({
  row,
  onPublish,
  onSync
}: {
  row: LaneRow
  onPublish: (id: string) => void
  onSync: (id: string) => void
}): JSX.Element {
  return (
    <li className={`conductor-lane conductor-lane-${row.status}`}>
      <span className="conductor-lane-role">{row.roleId}</span>
      <span className="conductor-lane-agent">{row.agentLabel}</span>
      <span className="conductor-lane-counts">
        ↑{row.ahead} ↓{row.behind}
      </span>
      {row.statusDetail && <span className="conductor-lane-detail">{row.statusDetail}</span>}
      {row.warnings.map((warning) => (
        <span key={warning} className="conductor-lane-warning">{warning}</span>
      ))}
      <button disabled={!row.canPublish} title={row.publishHint} onClick={() => onPublish(row.id)}>
        Publish
      </button>
      <button disabled={!row.canSync} title={row.syncHint} onClick={() => onSync(row.id)}>
        Sync
      </button>
    </li>
  )
}
