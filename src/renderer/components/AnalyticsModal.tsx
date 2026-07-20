import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, CharacterDef } from '../../shared/types'
import type { ActivityEvent } from '../../shared/api'
import type { CommitActivity } from '../../shared/tracker'
import { formatUsd, formatCredits } from '../state-meta'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  onClose: () => void
}

type Tab = 'spend' | 'activity'

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
  const [tab, setTab] = useState<Tab>('spend')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [commits, setCommits] = useState<CommitActivity[]>([])

  useEffect(() => {
    void window.crew.getEvents().then(setEvents)
    void window.crew.getCommitActivity().then(setCommits)
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
  const totalSpend = roster.reduce((a, s) => a + (s.costUsd || 0), 0)
  const totalCredits = roster.reduce((a, s) => a + (s.creditsUsed || 0), 0)
  const totalWait = roster.reduce((a, s) => a + (waiting[s.id] || 0), 0)

  // The Activity tab is a commit feed (newest first) — the git history across the
  // open sessions' repos. Session state churn (idle/working) is deliberately not
  // shown here; it's low-signal and would crowd out the commit notes.
  const feed = useMemo(() => [...commits].sort((a, b) => b.ts - a.ts).slice(0, 60), [commits])

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Activity &amp; spend</h2>

        <div className="analytics-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'spend'}
            className={`analytics-tab ${tab === 'spend' ? 'is-on' : ''}`}
            onClick={() => setTab('spend')}
          >
            Spend
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'activity'}
            className={`analytics-tab ${tab === 'activity' ? 'is-on' : ''}`}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
        </div>

        {tab === 'spend' ? (
          <div className="analytics__scroll">
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
          </div>
        ) : (
          <div className="analytics__scroll analytics__feed">
            {feed.length === 0 ? (
              <div className="muted">No commits yet.</div>
            ) : (
              feed.map((item, i) => (
                <div key={i} className="timeline-row timeline-row--commit">
                  <span className="timeline-time">{new Date(item.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                  <span className="commit-chip">
                    <span className="commit-chip__sha">{item.sha}</span>
                    <span className="commit-chip__proj">{item.project}</span>
                  </span>
                  <span className={`commit-chip__msg ${item.isRelease ? 'is-rel' : ''}`} title={item.subject}>
                    {item.subject}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
