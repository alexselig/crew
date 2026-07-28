import { useEffect, useMemo, useState } from 'react'
import type { LaunchResult, PastWeek, Project, RunningServer, TrackerData } from '../../shared/tracker'

interface Props {
  onClose: () => void
}

const FRAMEWORK_LABEL: Record<string, string> = { next: 'Next.js', vite: 'Vite', electron: 'Electron', node: 'Node', static: 'Static' }
const ORIGIN_LABEL: Record<string, string> = { work: 'Work', personal: 'Personal', external: 'External' }

/** Compact token count, e.g. 1_650_000 → "1.6M", 22_555 → "23k". */
function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/** Build the metadata line for an expanded project (identity + location bits;
 * recency/tree-state now live in the Shipped band). */
function metaBits(p: Project): { text: string; strong?: boolean; warn?: boolean; mono?: boolean }[] {
  const bits: { text: string; strong?: boolean; warn?: boolean; mono?: boolean }[] = []
  if (p.dir) bits.push({ text: `📁 ~/${p.dir}`, mono: true })
  if (p.version && p.version !== '—') bits.push({ text: p.version, strong: true })
  if (p.origin) bits.push({ text: ORIGIN_LABEL[p.origin] || p.origin })
  if (p.stats?.framework) bits.push({ text: FRAMEWORK_LABEL[p.stats.framework] || p.stats.framework })
  if (p.stats?.commitCount) bits.push({ text: `${p.stats.commitCount} commits` })
  if (p.branch && p.branch !== 'main' && p.branch !== 'master') bits.push({ text: p.branch })
  return bits
}

/** One-line "what's been checked in" summary for the Shipped band. */
function shipSummary(p: Project): string {
  const s = p.stats
  if (!s) return ''
  const bits: string[] = []
  if (s.commitsLastWeek > 0) bits.push(`${s.commitsLastWeek} commit${s.commitsLastWeek > 1 ? 's' : ''} this week`)
  else if (s.lastCommitWhen) bits.push(`last commit ${s.lastCommitWhen}`)
  if (s.ahead > 0) bits.push(`${s.ahead} to push`)
  bits.push(s.uncommitted > 0 ? `${s.uncommitted} uncommitted` : 'clean tree')
  return bits.join('  ·  ')
}

/**
 * Full-screen "Project Index" — a faithful in-app port of ~/project-tracker,
 * scoped to the working directories of the currently open sessions. Each project
 * is derived live from disk (git, package.json, task files): status, version,
 * next steps, commit/feature history, and open/launch actions.
 */
export function ProjectTracker({ onClose }: Props): JSX.Element {
  const [data, setData] = useState<TrackerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>('past')
  const [pastWeek, setPastWeek] = useState<PastWeek | null>(null)
  const [pastLoading, setPastLoading] = useState(true)
  const [running, setRunning] = useState<Record<string, RunningServer>>({})
  const [launching, setLaunching] = useState<Set<string>>(new Set())
  const [launchNote, setLaunchNote] = useState<Record<string, string>>({})
  const [auto, setAuto] = useState(true)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function refresh(): Promise<void> {
    try {
      const [d, servers] = await Promise.all([window.crew.scanTracker(), window.crew.getRunningServers()])
      setData(d)
      const run: Record<string, RunningServer> = {}
      for (const r of servers) run[r.id] = r
      setRunning(run)
      // Default open: every project that still has an open next-step item.
      setExpanded((prev) => {
        if (prev.size) return prev
        const exp = new Set<string>()
        for (const g of d.groups) for (const p of g.projects) if (p.nextSteps.length) exp.add(p.id)
        return exp
      })
      setLoading(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  // The Past Week review reads the Copilot CLI history DB (a heavier, read-only
  // scan), so it loads once on mount and on explicit Refresh — never in the 20s
  // auto-loop that re-scans the live project tree.
  async function loadPastWeek(): Promise<void> {
    try {
      const pw = await window.crew.getPastWeek()
      setPastWeek(pw)
    } catch {
      setPastWeek(null)
    } finally {
      setPastLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    void loadPastWeek()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-refresh (re-scan) every 20s while enabled, mirroring the reference.
  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => void refresh(), 20000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto])

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleHistory = (id: string): void =>
    setOpenHistory((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const groups = useMemo(() => {
    if (!data) return []
    return filter === 'all' ? data.groups : data.groups.filter((g) => g.tag === filter)
  }, [data, filter])

  const openLink = (url: string | null): void => {
    if (url) void window.crew.openExternal(url)
  }

  async function doLaunch(id: string): Promise<void> {
    setLaunching((prev) => new Set(prev).add(id))
    setLaunchNote((prev) => ({ ...prev, [id]: 'Starting dev server… (first compile can take ~10–20s)' }))
    let res: LaunchResult
    try {
      res = await window.crew.launchProject(id)
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    setLaunching((prev) => {
      const n = new Set(prev)
      n.delete(id)
      return n
    })
    if (res.ok && res.url) {
      setRunning((prev) => ({ ...prev, [id]: { id, label: res.label ?? '', port: res.port ?? null, url: res.url ?? null, framework: res.framework ?? null, status: 'running', startedAt: Date.now(), pid: res.pid ?? 0, external: res.external } }))
      setLaunchNote((prev) => ({ ...prev, [id]: `Running at ${res.url}${res.slow ? ' — still compiling, give it a moment.' : ''}` }))
      if (!res.slow) void window.crew.openExternal(res.url)
    } else if (res.ok) {
      setRunning((prev) => ({ ...prev, [id]: { id, label: res.label ?? '', port: null, url: null, framework: res.framework ?? null, status: 'running', startedAt: Date.now(), pid: res.pid ?? 0 } }))
      setLaunchNote((prev) => ({ ...prev, [id]: res.note ?? 'Launched.' }))
    } else {
      setLaunchNote((prev) => ({ ...prev, [id]: `Couldn't launch: ${res.error ?? 'unknown error'}` }))
    }
  }

  async function doStop(id: string): Promise<void> {
    await window.crew.stopProject(id)
    setRunning((prev) => {
      const n = { ...prev }
      delete n[id]
      return n
    })
    setLaunchNote((prev) => {
      const n = { ...prev }
      delete n[id]
      return n
    })
  }

  function renderActions(p: Project): JSX.Element | null {
    const run = running[p.id]
    const btns: JSX.Element[] = []
    if (p.github) {
      btns.push(
        <button type="button" key="gh" className="tracker-btn" onClick={() => openLink(p.github)}>
          ↗ GitHub
        </button>
      )
    }
    if (p.live) {
      btns.push(
        <button type="button" key="live" className="tracker-btn tracker-btn--live" onClick={() => openLink(p.live)}>
          ◆ Live demo
        </button>
      )
    }
    if (p.launch.launchable) {
      if (run && run.url) {
        const short = run.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
        btns.push(
          <button type="button" key="open" className="tracker-btn tracker-btn--open" onClick={() => openLink(run.url)}>
            ▶ Open {short}
          </button>
        )
        btns.push(
          <button type="button" key="stop" className="tracker-btn tracker-btn--stop" onClick={() => void doStop(p.id)}>
            {run.external ? '✕ Untrack' : '■ Stop'}
          </button>
        )
      } else if (run && run.status === 'running') {
        btns.push(
          <span key="running" className="tracker-btn">
            ▶ Running (app window)
          </span>
        )
        btns.push(
          <button type="button" key="stop" className="tracker-btn tracker-btn--stop" onClick={() => void doStop(p.id)}>
            ■ Stop
          </button>
        )
      } else if (launching.has(p.id)) {
        btns.push(
          <button type="button" key="starting" className="tracker-btn tracker-btn--launch" disabled>
            <span className="tracker-spin" /> Starting…
          </button>
        )
      } else {
        btns.push(
          <button type="button" key="launch" className="tracker-btn tracker-btn--launch" onClick={() => void doLaunch(p.id)}>
            ▶ Launch local
          </button>
        )
      }
    }
    return btns.length ? <div className="tracker-acts">{btns}</div> : null
  }

  function renderProject(p: Project): JSX.Element {
    const isOpen = expanded.has(p.id)
    const n = p.nextSteps.length
    const when = p.lastActiveWhen || p.stats?.lastCommitWhen || ''
    const histOpen = openHistory.has(p.id)
    const note = launchNote[p.id]
    return (
      <div className={`tracker-proj ${isOpen ? 'is-open' : ''} ${p.found ? '' : 'is-dim'}`} key={p.id} data-id={p.id}>
        <button type="button" className="tracker-row" onClick={() => toggle(p.id)} title={p.dir ?? p.label} aria-expanded={isOpen}>
          <span className={`tracker-dot tracker-dot--${p.status}`} />
          <span className="tracker-row__name">
            {p.label}
            {p.origin && <span className="tracker-row__origin">{ORIGIN_LABEL[p.origin] || p.origin}</span>}
          </span>
          {n > 0 ? (
            <span className="tracker-row__open">{n} open</span>
          ) : (p.stats?.uncommitted ?? 0) > 0 ? (
            <span className="tracker-row__open tracker-row__open--warn">{p.stats!.uncommitted} uncommitted</span>
          ) : (
            <span className="tracker-row__open tracker-row__open--idle">idle</span>
          )}
          <span className="tracker-row__when">{when}</span>
          <span className="tracker-row__chev">▸</span>
        </button>

        {isOpen && (
          <div className="tracker-detail">
            {(() => {
              const bits = metaBits(p)
              return bits.length ? (
                <div className="tracker-meta">
                  {bits.map((b, i) => (
                    <span key={i} className={`${b.strong ? 'tracker-meta__strong' : ''} ${b.warn ? 'tracker-meta__warn' : ''} ${b.mono ? 'tracker-meta__mono' : ''}`}>
                      {b.text}
                    </span>
                  ))}
                </div>
              ) : null
            })()}

            {p.note && <div className="tracker-note">⚠ {p.note}</div>}

            {renderActions(p)}

            {note && <div className="tracker-launchbox">{note}</div>}

            {p.found && (p.commits.length > 0 || (p.stats?.uncommitted ?? 0) > 0) && (
              <div className="tracker-sec tracker-sec--ship">
                <div className="tracker-sec__h">Recently shipped</div>
                {shipSummary(p) && <div className="tracker-ship__summary">{shipSummary(p)}</div>}
                {p.commits.length > 0 && (
                  <div className="tracker-commits tracker-commits--inline">
                    {p.commits.slice(0, 3).map((c, i) => (
                      <div className="tracker-commit" key={`s-${i}`}>
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

            {p.nextSteps.length > 0 && (
              <div className="tracker-sec">
                <div className="tracker-sec__h">
                  Open tasks <span className="tracker-sec__n">{p.nextSteps.length}</span>
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

            {p.proposedNextSteps.length > 0 && (
              <div className="tracker-sec tracker-sec--proposed">
                <div className="tracker-sec__h">
                  Proposed next steps <span className="tracker-sec__hint">suggested</span>
                </div>
                <ul className="tracker-tasks tracker-tasks--sugg">
                  {p.proposedNextSteps.map((t, i) => (
                    <li key={i}>
                      <span className="tracker-tasks__mk">✦</span>
                      <span>{t.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(p.commits.length > 3 || p.changelog.length > 0) && (
              <div className="tracker-hist">
                <button type="button" className={`tracker-hist__toggle ${histOpen ? 'is-open' : ''}`} onClick={() => toggleHistory(p.id)}>
                  <span className="tracker-hist__caret">▸</span>{' '}
                  {p.changelog.length ? 'Full history — changelog + earlier commits' : 'Earlier commits'}
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
                    {p.commits.slice(3).map((c, i) => (
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

  function renderPastWeek(): JSX.Element {
    if (pastLoading && !pastWeek) return <div className="tracker-empty">Reading your Copilot history…</div>
    if (!pastWeek || !pastWeek.available)
      return <div className="tracker-empty">No Copilot CLI history found for the past week.</div>
    const { stats, projects, days, followups, rangeLabel } = pastWeek
    return (
      <div className="pastweek">
        <p className="pastweek__range">
          {rangeLabel}
          {stats.messages > 0 ? ` · ${stats.messages.toLocaleString()} messages` : ''}
          {stats.topModel ? ` · mostly ${stats.topModel}` : ''}
        </p>

        {projects.length > 0 && (
          <section className="pastweek__section">
            <div className="tracker-group__head">
              <span className="tracker-group__label">Projects</span>
              <span className="tracker-group__line" />
              <span className="tracker-group__count">{projects.length}</span>
            </div>
            <div className="pastweek__projects">
              {projects.map((pr) => (
                <div className="pw-proj" key={pr.name}>
                  <span className="pw-proj__name">{pr.name}</span>
                  <span className="pw-proj__meta">
                    {pr.sessions} session{pr.sessions === 1 ? '' : 's'}
                    {pr.files > 0 ? ` · ${pr.files} file${pr.files === 1 ? '' : 's'}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="pastweek__section">
          <div className="tracker-group__head">
            <span className="tracker-group__label">Timeline</span>
            <span className="tracker-group__line" />
          </div>
          {days.length === 0 ? (
            <div className="tracker-empty">No sessions recorded this week.</div>
          ) : (
            days.map((day) => (
              <div className="pw-day" key={day.date}>
                <div className="pw-day__head">
                  <span className="pw-day__label">{day.label}</span>
                  <span className="pw-day__count">
                    {day.sessions.length} session{day.sessions.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="pw-day__sessions">
                  {day.sessions.map((s) => (
                    <div className="pw-sess" key={s.id}>
                      <span className="pw-sess__time">{s.time}</span>
                      <span className="pw-sess__title">{s.title}</span>
                      {s.turns > 0 && (
                        <span className="pw-sess__turns">
                          {s.turns} msg{s.turns === 1 ? '' : 's'}
                        </span>
                      )}
                      {s.projects.length > 0 && <span className="pw-sess__proj">{s.projects.join(' · ')}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>

        {followups.length > 0 && (
          <section className="pastweek__section">
            <div className="tracker-group__head">
              <span className="tracker-group__label">Follow-ups</span>
              <span className="tracker-group__line" />
              <span className="tracker-group__count">{followups.length}</span>
            </div>
            <ul className="pw-followups">
              {followups.map((f) => (
                <li className="pw-follow" key={f.id}>
                  <span className="pw-follow__text">{f.text}</span>
                  <span className="pw-follow__src">{f.sessionTitle}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="tracker">
      <div className="tracker__inner">
        <header className="tracker__masthead">
          <div className="tracker__top">
            <span className="tracker__eyebrow">Project Index — Vol. 1</span>
            <div className="tracker__controls">
              <label className="tracker__auto">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto
              </label>
              <button
                type="button"
                className="tracker__ctl"
                onClick={() => {
                  void refresh()
                  void loadPastWeek()
                }}
                title="Rescan now"
              >
                Refresh
              </button>
              <button type="button" className="tracker__close" title="Close (Esc)" onClick={onClose}>
                ✕
              </button>
            </div>
          </div>

          <h1 className="tracker__title">
            Project <em>Tracker</em>
          </h1>
          <div className="tracker__rule" />

          {filter === 'past' ? (
            <div className="tracker__stats">
              <div className="tracker-stat">
                <span className="tracker-stat__num">{pastWeek?.available ? pastWeek.stats.sessions : '–'}</span>
                <span className="tracker-stat__label">Sessions</span>
              </div>
              <div className="tracker-stat">
                <span className="tracker-stat__num">{pastWeek?.available ? pastWeek.stats.activeDays : '–'}</span>
                <span className="tracker-stat__label">Active days</span>
              </div>
              <div className="tracker-stat">
                <span className="tracker-stat__num">{pastWeek?.available ? pastWeek.stats.projects : '–'}</span>
                <span className="tracker-stat__label">Projects</span>
              </div>
              <div className="tracker-stat">
                <span className="tracker-stat__num tracker-stat__num--accent">
                  {pastWeek?.available ? fmtTokens(pastWeek.stats.tokens) : '–'}
                </span>
                <span className="tracker-stat__label">Tokens</span>
              </div>
            </div>
          ) : (
            <div className="tracker__stats">
              <div className="tracker-stat">
                <span className="tracker-stat__num">{data ? data.totals.projects : '–'}</span>
                <span className="tracker-stat__label">Projects</span>
              </div>
              <div className="tracker-stat">
                <span className="tracker-stat__num">{data ? data.totals.shippedWeek : '–'}</span>
                <span className="tracker-stat__label">Shipped · 7d</span>
              </div>
              <div className="tracker-stat">
                <span className="tracker-stat__num tracker-stat__num--accent">{data ? data.totals.openTasks : '–'}</span>
                <span className="tracker-stat__label">Open tasks</span>
              </div>
            </div>
          )}

          <nav className="tracker-filters">
            <button type="button" className={`tracker-filter ${filter === 'past' ? 'is-on' : ''}`} onClick={() => setFilter('past')}>
              Past Week
            </button>
            <button type="button" className={`tracker-filter ${filter === 'all' ? 'is-on' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            {data &&
              data.groups.length > 1 &&
              data.groups.map((g) => (
                <button type="button" key={g.tag} className={`tracker-filter ${filter === g.tag ? 'is-on' : ''}`} onClick={() => setFilter(g.tag)}>
                  {g.label} · {g.projects.length}
                </button>
              ))}
          </nav>
        </header>

        <main className="tracker__main">
          {filter === 'past' ? (
            renderPastWeek()
          ) : loading ? (
            <div className="tracker-empty">Scanning repositories…</div>
          ) : error ? (
            <div className="tracker-empty">Couldn’t scan projects — {error}</div>
          ) : !data || data.groups.length === 0 ? (
            <div className="tracker-empty">No projects with open sessions.</div>
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
        </main>

        {filter === 'past' ? (
          pastWeek?.available && (
            <footer className="tracker__colophon">
              <span>
                {pastWeek.stats.sessions} sessions · {pastWeek.stats.activeDays} active days
                {pastWeek.stats.topModel ? ` · mostly ${pastWeek.stats.topModel}` : ''}
              </span>
              <span>Read-only, from your Copilot CLI history</span>
            </footer>
          )
        ) : data ? (
          <footer className="tracker__colophon">
            <span>
              {data.totals.repos} git repos · {data.totals.sessions} open sessions
            </span>
            <span>Grouped by your Crew session tags · click a title to expand</span>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
