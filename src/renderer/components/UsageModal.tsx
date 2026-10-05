import { useEffect, useState } from 'react'
import type { Settings, UsageSummaryInfo } from '../../shared/types'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onClose: () => void
}

/**
 * "Your usage" — the consent screen and the payback, on one surface.
 *
 * Deliberately shows the user their own numbers rather than only collecting
 * them. The consent copy states exactly what is recorded and what is not, and
 * the log's path is shown so the claim can be checked rather than believed.
 */
export function UsageModal({ settings, onChange, onClose }: Props): JSX.Element {
  const [summary, setSummary] = useState<UsageSummaryInfo | null>(null)
  const on = settings.usageInsights === true

  async function refresh(): Promise<void> {
    setSummary(await window.crew.getUsageSummary())
  }

  useEffect(() => {
    void refresh()
  }, [on])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function wipe(): Promise<void> {
    if (!window.confirm('Delete your usage log? This cannot be undone.')) return
    await window.crew.wipeUsage()
    await refresh()
  }

  const totals = summary?.totals ?? {}
  const views = Object.entries(summary?.views ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--usage" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Your usage</h2>

        <label className="usage-consent">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => onChange({ usageInsights: e.target.checked })}
          />
          <span>
            <strong>Count how I use Crew</strong>
            <span className="usage-consent__desc">
              Off by default. Nothing is sent anywhere — Crew has no analytics service and this
              adds none. It appends counters and durations to a plain text file on this Mac:
              sessions created, opened and closed, prompts submitted, which view you use, agent
              runs, and whether a resume offer was taken. It never records your prompts, your
              session output, or file contents.
            </span>
          </span>
        </label>

        {summary?.path && <p className="usage-path">{summary.path}</p>}

        {summary && summary.events === 0 && (
          <p className="sets__empty">
            {on
              ? 'Nothing counted yet. Numbers will appear here as you work.'
              : 'Nothing has been counted. Switch it on above if you want these numbers.'}
          </p>
        )}

        {summary && summary.events > 0 && (
          <>
            <div className="usage-figures">
              <Figure n={summary.events} label="events" />
              <Figure n={summary.days} label={summary.days === 1 ? 'day' : 'days'} />
              <Figure n={totals['session.created'] ?? 0} label="sessions started" />
              <Figure n={totals['session.prompt'] ?? 0} label="prompts" />
              <Figure n={Math.round(summary.dwellMs / 60000)} label="minutes in session" />
              <Figure n={totals['agent.invoked'] ?? 0} label="agent runs" />
            </div>

            {views.length > 0 && (
              <div className="usage-block">
                <h3 className="usage-block__title">Views used</h3>
                <ul className="usage-rows">
                  {views.map(([name, n]) => (
                    <li key={name} className="usage-row">
                      <span>{name}</span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(totals['resume.offered'] ?? 0) > 0 && (
              <div className="usage-block">
                <h3 className="usage-block__title">Resume offers</h3>
                <ul className="usage-rows">
                  <li className="usage-row">
                    <span>offered</span>
                    <span>{totals['resume.offered'] ?? 0}</span>
                  </li>
                  <li className="usage-row">
                    <span>taken</span>
                    <span>{totals['resume.accepted'] ?? 0}</span>
                  </li>
                </ul>
              </div>
            )}
          </>
        )}

        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--danger"
            disabled={!summary || summary.events === 0}
            onClick={() => void wipe()}
          >
            Delete my usage log
          </button>
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Figure({ n, label }: { n: number; label: string }): JSX.Element {
  return (
    <div className="usage-figure">
      <span className="usage-figure__n">{n.toLocaleString()}</span>
      <span className="usage-figure__label">{label}</span>
    </div>
  )
}
