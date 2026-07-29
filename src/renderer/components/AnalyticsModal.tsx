import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, CharacterDef, Settings } from '../../shared/types'
import type { ActivityEvent } from '../../shared/api'
import type { CommitActivity } from '../../shared/tracker'
import type { UsageAnalytics, UsageRangeKey } from '../../shared/usage'
import { formatUsd, formatCredits, sessionUsd } from '../state-meta'
import { CharacterArt, hasCharacterArt } from '../character-art'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  settings: Settings | null
  onClose: () => void
}

type Tab = 'spend' | 'activity'

const NEEDS = new Set(['WAITING_INPUT', 'WAITING_APPROVAL'])

/** Compact token count, e.g. 1_650_000 → "1.6M", 2.1e9 → "2.1B". */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

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

export function AnalyticsModal({ roster, characters, settings, onClose }: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('spend')
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [commits, setCommits] = useState<CommitActivity[]>([])
  const [usage, setUsage] = useState<UsageAnalytics | null>(null)
  const [range, setRange] = useState<UsageRangeKey>('week')

  useEffect(() => {
    void window.crew.getEvents().then(setEvents)
    void window.crew.getCommitActivity().then(setCommits)
    void window.crew.getUsageAnalytics().then(setUsage)
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
  const costMode = settings?.costMode ?? 'auto'
  const aicPerUsd = settings?.aicPerUsd ?? 100
  const spendOf = (s: SessionInfo): number => sessionUsd(s, costMode, aicPerUsd)
  const totalSpend = roster.reduce((a, s) => a + spendOf(s), 0)
  const totalCredits = roster.reduce((a, s) => a + (s.creditsUsed || 0), 0)
  const totalWait = roster.reduce((a, s) => a + (waiting[s.id] || 0), 0)

  // The Activity tab is a commit feed (newest first) — the git history across the
  // open sessions' repos. Session state churn (idle/working) is deliberately not
  // shown here; it's low-signal and would crowd out the commit notes.
  const feed = useMemo(() => [...commits].sort((a, b) => b.ts - a.ts).slice(0, 60), [commits])

  // Selected token-usage range + chart/intensity scales for the Activity tab.
  const activeRange = useMemo(() => usage?.ranges.find((r) => r.key === range) ?? null, [usage, range])
  const chartMax = useMemo(() => (activeRange ? Math.max(1, ...activeRange.series.map((b) => b.tokens)) : 1), [activeRange])
  const sliceMax = useMemo(() => (activeRange ? Math.max(1, ...activeRange.projects.map((p) => p.tokens)) : 1), [activeRange])

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
            {costMode === 'manual' && (
              <p className="analytics__note">
                Manual — spend calculated from reported usage at {formatCredits(aicPerUsd)} units = $1.
              </p>
            )}
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
                        <span className="analytics__glyph" style={{ color: s.color }}>
                          {hasCharacterArt(s.characterId) ? (
                            <CharacterArt id={s.characterId} size={18} />
                          ) : (
                            glyph(s.characterId)
                          )}
                        </span>{' '}
                        {s.label}
                      </td>
                      <td>{fmtDur(waiting[s.id] || 0)}</td>
                      <td>{formatUsd(spendOf(s))}</td>
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
          <div className="analytics__scroll">
            <div className="usage-range" role="group" aria-label="Token usage time range">
              {(usage?.ranges ?? []).map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`usage-range__opt ${range === r.key ? 'is-on' : ''}`}
                  aria-pressed={range === r.key}
                  onClick={() => setRange(r.key)}
                >
                  {r.short}
                </button>
              ))}
            </div>

            {!usage ? (
              <div className="muted usage__msg">Reading token history…</div>
            ) : !usage.available ? (
              <div className="muted usage__msg">No Copilot CLI history found.</div>
            ) : !activeRange || activeRange.totalTokens === 0 ? (
              <div className="muted usage__msg">No token usage in this range.</div>
            ) : (
              <>
                <div className="usage__headline">
                  <span className="usage__big">{fmtTokens(activeRange.totalTokens)}</span>
                  <span className="usage__unit">tokens</span>
                  <span className="usage__meta">
                    {activeRange.title.toLowerCase()} · {activeRange.bucketLabel}
                    {activeRange.totalAiu > 0 ? ` · ${formatCredits(activeRange.totalAiu / 1e9)} credits` : ''}
                    {activeRange.peakLabel ? ` · peak ${activeRange.peakLabel}` : ''}
                  </span>
                </div>

                <div className="usage-chart" role="img" aria-label={`Token usage over time — ${activeRange.title}`}>
                  {activeRange.series.map((b, i) => (
                    <div
                      key={i}
                      className={`usage-bar ${b.tokens > 0 ? '' : 'is-empty'}`}
                      style={{ height: `${(b.tokens / chartMax) * 100}%` }}
                      title={`${b.label ? b.label + ' · ' : ''}${fmtTokens(b.tokens)} tokens`}
                    />
                  ))}
                </div>
                <div className="usage-axis">
                  {activeRange.series.map((b, i) => (
                    <span key={i} className="usage-axis__tick">
                      {b.label}
                    </span>
                  ))}
                </div>

                {activeRange.projects.length > 0 && (
                  <div className="usage-intensity">
                    <div className="usage-intensity__head">
                      Project intensity <span className="muted">· tokens by repo / session</span>
                    </div>
                    {activeRange.projects.map((p, i) => (
                      <div className="usage-int" key={i}>
                        <span className="usage-int__name" title={p.name}>
                          {p.kind === 'session' && p.name !== 'Other' ? '❯ ' : ''}
                          {p.name}
                        </span>
                        <span className="usage-int__track">
                          <span className="usage-int__fill" style={{ width: `${(p.tokens / sliceMax) * 100}%` }} />
                        </span>
                        <span className="usage-int__val">{fmtTokens(p.tokens)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            <div className="usage-commits">
              <div className="usage-intensity__head">Recent commits</div>
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
