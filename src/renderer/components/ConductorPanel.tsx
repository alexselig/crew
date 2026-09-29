import { useCallback, useEffect, useState } from 'react'
import { buildRoster, describeOutcome, type LaneRow } from '../conductor-view-model'
import type { ConductorSnapshot } from '../../shared/conductor'

export function ConductorPanel(): JSX.Element | null {
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

  const publish = useCallback(async (laneId: string) => {
    setMessage(describeOutcome(await window.crew.publishLane(laneId)))
  }, [])

  const sync = useCallback(async (laneId: string) => {
    const outcome = await window.crew.syncLane(laneId)
    setMessage(outcome.ok ? 'Lane synced' : outcome.message)
  }, [])

  if (!snapshot || !snapshot.enabled) return null
  const rows = buildRoster(snapshot)

  return (
    <section className="conductor">
      <header className="conductor-head">
        <h2>Conductor</h2>
        {snapshot.needsAttention && (
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
