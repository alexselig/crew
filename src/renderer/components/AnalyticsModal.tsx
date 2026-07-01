import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import type { ActivityEvent } from '../../shared/api'
import { STATE_META, formatUsd, formatCredits } from '../state-meta'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  onClose: () => void
}

const NEEDS = new Set(['WAITING_INPUT', 'WAITING_APPROVAL'])

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Sum time each session spent in a needs-you state, from the transition log. */
function waitingBySession(events: ActivityEvent[], now: number): Record<string, number> {
  const bySession = new Map<string, ActivityEvent[]>()
  for (const e of events) {
    const arr = bySession.get(e.id) ?? []
    arr.push(e)
    bySession.set(e.id, arr)
  }
  const out: Record<string, number> = {}
  for (const [id, evs] of bySession) {
    let total = 0
    for (let i = 0; i < evs.length; i++) {
      const end = i + 1 < evs.length ? evs[i + 1].ts : now
      if (NEEDS.has(evs[i].to)) total += end - evs[i].ts
    }
    out[id] = total
  }
  return out
}

export function AnalyticsModal({ roster, characters, onClose }: Props): JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([])

  useEffect(() => {
    void window.crew.getEvents().then(setEvents)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const waiting = useMemo(() => waitingBySession(events, Date.now()), [events])
  const glyph = (id: string): string => characters.find((c) => c.id === id)?.glyph ?? '●'
  const labelOf = (id: string): string => roster.find((s) => s.id === id)?.label ?? id.slice(0, 6)
  const totalSpend = roster.reduce((a, s) => a + (s.costUsd || 0), 0)
  const totalCredits = roster.reduce((a, s) => a + (s.creditsUsed || 0), 0)
  const totalWait = roster.reduce((a, s) => a + (waiting[s.id] || 0), 0)
  const recent = [...events].slice(-18).reverse()

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Activity &amp; spend</h2>

        <table className="analytics">
          <thead>
            <tr>
              <th>Session</th>
              <th>Waiting</th>
              <th>Spend</th>
              <th>Credits</th>
            </tr>
          </thead>
          <tbody>
            {roster.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No sessions.
                </td>
              </tr>
            ) : (
              roster.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="analytics__glyph">{glyph(s.characterId)}</span> {s.label}
                  </td>
                  <td>{fmtDur(waiting[s.id] || 0)}</td>
                  <td>{formatUsd(s.costUsd)}</td>
                  <td>{formatCredits(s.creditsUsed)}</td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{fmtDur(totalWait)}</td>
              <td>{formatUsd(totalSpend)}</td>
              <td>{formatCredits(totalCredits)}</td>
            </tr>
          </tfoot>
        </table>

        <div className="analytics__timeline">
          <span className="field__label">Recent activity</span>
          {recent.length === 0 ? (
            <div className="muted">No events yet.</div>
          ) : (
            recent.map((e, i) => (
              <div key={i} className="timeline-row">
                <span className="timeline-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="timeline-label">{labelOf(e.id)}</span>
                <span className="timeline-arrow">→</span>
                <span style={{ color: STATE_META[e.to].color }}>{STATE_META[e.to].label}</span>
              </div>
            ))
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
