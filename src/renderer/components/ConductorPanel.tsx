import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildRoster,
  conductorPanelMode,
  describeAcknowledgeOutcome,
  describeAttention,
  describeOutcome,
  describeReconcileReport,
  describeUnexpectedFailure,
  type LaneRow
} from '../conductor-view-model'
import type { ConductorSnapshot } from '../../shared/conductor'

interface Props {
  /** The workspace this panel is showing. Every conductor IPC call names it
   *  explicitly (review finding 1): main keeps no active workspace of its
   *  own for conductor, so two windows showing two workspaces each get
   *  their own truth, and a workspace switch that never reached main
   *  cannot make this panel report another workspace's lanes. */
  workspaceId: string | null
  /** Whether this workspace was created as a conducted one. False renders no
   *  conductor UI whatsoever — see conductorPanelMode. */
  conducted: boolean
  /** Opens the plan document view for an agent-written proposal file. */
  onLoadPlan: (file: File) => void
  /** Opens the blank composer, for a user who would rather write the roster
   *  than have the conductor propose one. Only reachable inside a conducted
   *  workspace that has no roster yet. */
  onComposeByHand: () => void
}

export function ConductorPanel({
  workspaceId,
  conducted,
  onLoadPlan,
  onComposeByHand
}: Props): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ConductorSnapshot | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Re-review finding I-4: which workspace this panel is showing RIGHT NOW,
  // readable from inside a promise callback that was started for an older
  // one. A publish that runs tests takes minutes, so a workspace switch
  // between the call and its `finally` is ordinary, not exotic — and
  // without this the refresh below would drop workspace A's snapshot onto a
  // panel now showing B, whose buttons would then send B's workspace id
  // with A's lane ids ("unknown lane").
  const shownWorkspace = useRef(workspaceId)

  useEffect(() => {
    shownWorkspace.current = workspaceId
    let cancelled = false
    // Dropped, not kept: the previous workspace's snapshot must not be on
    // screen while this one loads, or the user acts on another workspace's
    // lanes. 'loading' renders nothing, which is the honest state.
    setSnapshot(null)
    setMessage(null)
    // A standard workspace asks main nothing. getConductorState builds that
    // workspace's conductor backend on demand (see conductor-bootstrap's
    // backendFor), so polling it for every ordinary workspace the user
    // clicks through would construct a conductor for each one to be told,
    // every time, that there isn't one.
    if (!conducted) return () => {}
    void window.crew.getConductorState(workspaceId).then((state) => {
      if (!cancelled) setSnapshot(state)
    })
    // Broadcasts are not addressed to a window, so each carries the
    // workspace it describes and every other window's event is ignored.
    const off = window.crew.onConductorState((event) => {
      if (!cancelled && event.workspaceId === workspaceId) setSnapshot(event.state)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [workspaceId, conducted])

  // Every handler refreshes the snapshot straight from getConductorState()
  // in a `finally`, not only on the happy path — a rejected IPC call
  // (transport failure, never a structured refusal; see
  // describeUnexpectedFailure) must never leave the panel trusting a stale
  // broadcast. Re-fetching the real, current lock state is what stops a lane
  // looking permanently "publishing" after a rejection that no later
  // broadcast ever corrected.
  //
  // Finding I-4: the result is applied only if this panel is still showing
  // the workspace the call was made for. A late answer for a workspace the
  // user has already switched away from is dropped, never rendered.
  const refresh = useCallback(async () => {
    const state = await window.crew.getConductorState(workspaceId)
    if (shownWorkspace.current === workspaceId) setSnapshot(state)
  }, [workspaceId])

  // Wave 3, finding 2: I-4 dropped a late SNAPSHOT belonging to another
  // workspace but left its MESSAGE alone, so a publish on A that finished
  // after a switch still announced "Published…" or "tests failed" in B's
  // panel — a result describing work B's lanes never did, sitting under B's
  // roster. Every handler reports through here, so the drop rule is one
  // guard rather than four copies that can drift apart.
  const report = useCallback((text: string) => {
    if (shownWorkspace.current === workspaceId) setMessage(text)
  }, [workspaceId])

  const publish = useCallback(async (laneId: string) => {
    try {
      report(describeOutcome(await window.crew.publishLane(workspaceId, laneId)))
    } catch (error) {
      report(describeUnexpectedFailure('publish', error))
    } finally {
      void refresh()
    }
  }, [workspaceId, refresh, report])

  const sync = useCallback(async (laneId: string) => {
    try {
      const outcome = await window.crew.syncLane(workspaceId, laneId)
      report(outcome.ok ? 'Lane synced' : outcome.message)
    } catch (error) {
      report(describeUnexpectedFailure('sync', error))
    } finally {
      void refresh()
    }
  }, [workspaceId, refresh, report])

  // The way out of the needs-attention gate (review finding 7). Publish and
  // sync refuse while an interrupted operation is outstanding; a Re-check
  // reports what is holding them, and Acknowledge (below) is what closes it
  // on the record — without both controls, a single crashed publish left the
  // workspace read-only until the app was restarted.
  const recheck = useCallback(async () => {
    try {
      report(describeReconcileReport(await window.crew.reconcileConductor(workspaceId)))
    } catch (error) {
      report(describeUnexpectedFailure('recheck', error))
    } finally {
      void refresh()
    }
  }, [workspaceId, refresh, report])

  // Finding I-1: the actual exit from the needs-attention gate. A reconcile
  // can only REPORT an interrupted operation — nothing it does closes one,
  // so before this control existed a crash mid-publish refused publish and
  // sync in that workspace forever (and no git action escaped it, because
  // the journal, not git, is what reconcile classifies). Acknowledging
  // appends a terminal journal entry for the operation the user is looking
  // at, which is why it is a deliberate, per-operation button rather than
  // something a Re-check does silently on the user's behalf.
  const acknowledge = useCallback(async (opId: string) => {
    try {
      const outcome = await window.crew.acknowledgeConductorOperation(
        workspaceId,
        opId,
        'reviewed and acknowledged in the conductor panel'
      )
      report(describeAcknowledgeOutcome(outcome))
    } catch (error) {
      report(describeUnexpectedFailure('acknowledge', error))
    } finally {
      void refresh()
    }
  }, [workspaceId, refresh, report])

  const mode = conductorPanelMode(snapshot, conducted)
  if (mode === 'hidden' || mode === 'loading') return null

  if (mode === 'empty') {
    return (
      <section className="conductor conductor--empty">
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
        <button type="button" className="btn" onClick={onComposeByHand}>
          Compose by hand…
        </button>
      </section>
    )
  }

  // mode === 'active'
  const active = snapshot as ConductorSnapshot
  const rows = buildRoster(active)
  const attention = describeAttention(active)

  return (
    <section className="conductor">
      <header className="conductor-head">
        <h2>Conductor</h2>
        {attention && <span className="conductor-attention">{attention}</span>}
        <button type="button" className="conductor-recheck" onClick={() => void recheck()}>
          Re-check
        </button>
      </header>
      {active.operations.length > 0 && (
        <ul className="conductor-operations">
          {active.operations.map((op) => (
            <li
              key={op.opId}
              className={op.requiresHuman ? 'conductor-operation conductor-operation--human' : 'conductor-operation'}
            >
              <span className="conductor-operation-summary">{op.summary}</span>
              <button
                type="button"
                className="conductor-acknowledge"
                onClick={() => void acknowledge(op.opId)}
              >
                Acknowledge
              </button>
            </li>
          ))}
        </ul>
      )}
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
