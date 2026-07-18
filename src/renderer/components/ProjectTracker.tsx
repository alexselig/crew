import { useEffect, useMemo, useState } from 'react'
import type { TrackerData, TrackerProject } from '../../shared/tracker'
import { STATE_META } from '../state-meta'

interface Props {
  onClose: () => void
}

const FRAMEWORK_LABEL: Record<string, string> = {
  next: 'Next.js',
  vite: 'Vite',
  electron: 'Electron',
  node: 'Node',
  static: 'Static'
}
const ORIGIN_LABEL: Record<string, string> = { work: 'Work', personal: 'Personal', external: 'External' }

function metaBits(p: TrackerProject): string[] {
  const bits: string[] = []
  if (p.dir) bits.push(p.dir)
  if (p.version && p.version !== '—') bits.push(p.version)
  if (p.origin) bits.push(ORIGIN_LABEL[p.origin] || p.origin)
  if (p.framework) bits.push(FRAMEWORK_LABEL[p.framework] || p.framework)
  if (p.commitCount) bits.push(`${p.commitCount} commits`)
  if (p.lastCommitWhen) bits.push(`last commit ${p.lastCommitWhen}`)
  if (p.branch && p.branch !== 'main' && p.branch !== 'master') bits.push(p.branch)
  return bits
}

/**
 * Full-screen "Project Index" tracker. Indexes the working directories of the
 * currently open (active) sessions as projects, each derived live from disk
 * (git, package.json, task files): version, framework, commit history, next
 * steps, suggestions, GitHub/live links. Grouped into sections by session tag.
 * Projects with open next-step items are expanded by default. ✕ / Esc closes.
 */
export function ProjectTracker({ onClose }: Props): JSX.Element {
  const [data, setData] = useState<TrackerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>('all')

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    window.crew
      .scanTracker()
      .then((d) => {
        if (!alive) return
        setData(d)
        // Default open: every project that still has an open next-step item.
        const exp = new Set<string>()
        for (const g of d.groups) for (const p of g.projects) if (p.nextSteps.length) exp.add(p.cwd)
        setExpanded(exp)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const toggle = (cwd: string): void =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(cwd)) n.delete(cwd)
      else n.add(cwd)
      return n
    })
  const toggleHistory = (cwd: string): void =>
    setOpenHistory((prev) => {
      const n = new Set(prev)
      if (n.has(cwd)) n.delete(cwd)
      else n.add(cwd)
      return n
    })

  const groups = useMemo(() => {
    if (!data) return []
    return filter === 'all' ? data.groups : data.groups.filter((g) => g.tag === filter)
  }, [data, filter])

  const openLink = (url: string | null): void => {
    if (url) void window.crew.openExternal(url)
  }

  function renderProject(p: TrackerProject): JSX.Element {
    const isOpen = expanded.has(p.cwd)
    const n = p.nextSteps.length
    const when = p.lastActiveWhen || p.lastCommitWhen || ''
    const bits = metaBits(p)
    const histOpen = openHistory.has(p.cwd)
    return (
      <div className={`tracker-proj ${isOpen ? 'is-open' : ''}`} key={p.cwd} data-cwd={p.cwd}>
        <button type="button" className="tracker-row" onClick={() => toggle(p.cwd)} title={p.cwd} aria-expanded={isOpen}>
          <span className={`tracker-dot tracker-dot--${p.status}`} />
          <span className="tracker-row__name">
            {p.name}
            {p.origin && <span className="tracker-row__origin">{ORIGIN_LABEL[p.origin] || p.origin}</span>}
          </span>
          {n > 0 ? (
            <span className="tracker-row__open">{n} open</span>
          ) : (
            <span className="tracker-row__open tracker-row__open--idle">idle</span>
          )}
          <span className="tracker-row__when">{when}</span>
          <span className="tracker-row__chev">▸</span>
        </button>

        {isOpen && (
          <div className="tracker-detail">
            {bits.length > 0 && (
              <div className="tracker-meta">
                {bits.map((b, i) => (
                  <span key={i} className={i === 1 ? 'tracker-meta__strong' : ''}>
                    {b}
                  </span>
                ))}
                {p.uncommitted > 0 && (
                  <span className="tracker-meta__warn">{p.uncommitted} uncommitted</span>
                )}
              </div>
            )}

            {(p.github || p.live) && (
              <div className="tracker-acts">
                {p.github && (
                  <button type="button" className="tracker-btn" onClick={() => openLink(p.github)}>
                    ↗ GitHub
                  </button>
                )}
                {p.live && (
                  <button type="button" className="tracker-btn tracker-btn--live" onClick={() => openLink(p.live)}>
                    ◆ Live demo
                  </button>
                )}
              </div>
            )}

            <div className="tracker-sec">
              <div className="tracker-sec__h">
                Open sessions <span className="tracker-sec__n">{p.sessions.length}</span>
              </div>
              <div className="tracker-sessions">
                {p.sessions.map((s) => {
                  const meta = STATE_META[s.state]
                  return (
                    <div className="tracker-sess" key={s.id}>
                      <span className="tracker-sess__dot" style={{ background: p.color }} />
                      <span className="tracker-sess__name">{s.label}</span>
                      <span className={`tracker-sess__state tone-${meta.tone}`}>{meta.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {p.nextSteps.length > 0 && (
              <div className="tracker-sec">
                <div className="tracker-sec__h">
                  Next steps <span className="tracker-sec__n">{p.nextSteps.length}</span>
                </div>
                <ul className="tracker-tasks tracker-tasks--steps">
                  {p.nextSteps.map((t, i) => (
                    <li key={i}>
                      <span className="tracker-tasks__mk">▸</span>
                      <span>{t.text}</span>
                      <span className="tracker-tasks__src">{t.source}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {p.suggestions.length > 0 && (
              <div className="tracker-sec">
                <div className="tracker-sec__h">
                  Suggestions <span className="tracker-sec__n">{p.suggestions.length}</span>
                </div>
                <ul className="tracker-tasks tracker-tasks--sugg">
                  {p.suggestions.map((t, i) => (
                    <li key={i}>
                      <span className="tracker-tasks__mk">✦</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {p.commits.length > 0 && (
              <div className="tracker-hist">
                <button
                  type="button"
                  className={`tracker-hist__toggle ${histOpen ? 'is-open' : ''}`}
                  onClick={() => toggleHistory(p.cwd)}
                >
                  <span className="tracker-hist__caret">▸</span> What&rsquo;s been added — commit history
                </button>
                {histOpen && (
                  <div className="tracker-commits">
                    {p.changelog.map((c, i) => (
                      <div className="tracker-changelog" key={`cl-${i}`}>
                        <h5>{c.version}</h5>
                        <ul>
                          {c.items.map((it, j) => (
                            <li key={j}>{it}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {p.commits.map((c, i) => (
                      <div className="tracker-commit" key={`c-${i}`}>
                        <span className="tracker-commit__sha">{c.sha}</span>
                        <span className={`tracker-commit__msg ${c.isRelease ? 'is-rel' : ''}`} title={c.subject}>
                          {c.subject}
                        </span>
                        <span className="tracker-commit__when">{c.when || ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="tracker">
      <div className="tracker__inner">
        <div className="tracker__topbar">
          <span className="tracker__eyebrow">Project Index — Vol. 1</span>
          <button type="button" className="tracker__close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>

        <h1 className="tracker__title">
          Project <em>Tracker</em>
        </h1>
        <div className="tracker__rule" />

        <div className="tracker__stats">
          <div className="tracker-stat">
            <span className="tracker-stat__num">{data ? data.totals.projects : '—'}</span>
            <span className="tracker-stat__label">Projects</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num">{data ? data.totals.groups : '—'}</span>
            <span className="tracker-stat__label">Groups</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num tracker-stat__num--accent">{data ? data.totals.openTasks : '—'}</span>
            <span className="tracker-stat__label">Open tasks</span>
          </div>
        </div>

        {data && data.groups.length > 1 && (
          <div className="tracker-filters">
            <button
              type="button"
              className={`tracker-filter ${filter === 'all' ? 'is-on' : ''}`}
              onClick={() => setFilter('all')}
            >
              All
            </button>
            {data.groups.map((g) => (
              <button
                type="button"
                key={g.tag}
                className={`tracker-filter ${filter === g.tag ? 'is-on' : ''}`}
                onClick={() => setFilter(g.tag)}
              >
                {g.label} · {g.projects.length}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div className="tracker__empty">Scanning projects…</div>
        ) : error ? (
          <div className="tracker__empty">Couldn&rsquo;t scan projects — {error}</div>
        ) : !data || data.groups.length === 0 ? (
          <div className="tracker__empty">No projects with open sessions.</div>
        ) : (
          groups.map((g) => (
            <section className="tracker-group" key={g.tag}>
              <div className="tracker-group__head">
                <span className="tracker-group__label">{g.label}</span>
                <span className="tracker-group__line" />
                {g.blurb && <span className="tracker-group__blurb">{g.blurb}</span>}
                <span className="tracker-group__count">{g.projects.length}</span>
              </div>
              {g.projects.map(renderProject)}
            </section>
          ))
        )}

        {data && (
          <div className="tracker__colophon">
            <span>
              {data.totals.repos} git repos · {data.totals.sessions} open sessions
            </span>
            <span>Grouped by your Crew session tags · click a title to expand</span>
          </div>
        )}
      </div>
    </div>
  )
}
