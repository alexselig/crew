import { useEffect, useMemo, useState } from 'react'
import type { LaunchResult, Project, RunningServer, TrackerData } from '../../shared/tracker'

interface Props {
  onClose: () => void
}

const FRAMEWORK_LABEL: Record<string, string> = { next: 'Next.js', vite: 'Vite', electron: 'Electron', node: 'Node', static: 'Static' }
const ORIGIN_LABEL: Record<string, string> = { work: 'Work', personal: 'Personal', external: 'External' }

/** Build the metadata line for an expanded project (matches reference metaLine). */
function metaBits(p: Project): { text: string; strong?: boolean; warn?: boolean; mono?: boolean }[] {
  const bits: { text: string; strong?: boolean; warn?: boolean; mono?: boolean }[] = []
  if (p.dir) bits.push({ text: `📁 ~/${p.dir}`, mono: true })
  if (p.version && p.version !== '—') bits.push({ text: p.version, strong: true })
  if (p.origin) bits.push({ text: ORIGIN_LABEL[p.origin] || p.origin })
  if (p.stats?.framework) bits.push({ text: FRAMEWORK_LABEL[p.stats.framework] || p.stats.framework })
  if (p.stats?.commitCount) bits.push({ text: `${p.stats.commitCount} commits` })
  if (p.stats?.lastCommitWhen) bits.push({ text: `last commit ${p.stats.lastCommitWhen}` })
  if (p.branch && p.branch !== 'main' && p.branch !== 'master') bits.push({ text: p.branch })
  if (p.stats?.uncommitted) bits.push({ text: `${p.stats.uncommitted} uncommitted`, warn: true })
  return bits
}

/**
 * Full-screen "Project Index" — a faithful in-app port of ~/project-tracker,
 * scoped to the working directories of the currently open sessions. Each project
 * is derived live from disk (git, package.json, task files): status, version,
 * next steps, suggestions, commit/feature history, and open/launch actions.
 */
export function ProjectTracker({ onClose }: Props): JSX.Element {
  const [data, setData] = useState<TrackerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<string>('all')
  const [running, setRunning] = useState<Record<string, RunningServer>>({})
  const [launching, setLaunching] = useState<Set<string>>(new Set())
  const [launchNote, setLaunchNote] = useState<Record<string, string>>({})

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

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

            {p.nextSteps.length > 0 ? (
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
            ) : (
              p.found && (
                <div className="tracker-sec">
                  <div className="tracker-sec__h">Next steps</div>
                  <div className="tracker-empty">No open tasks tracked — add a TODO.md or a “Next steps” section.</div>
                </div>
              )
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

            {(p.commits.length > 0 || p.changelog.length > 0) && (
              <div className="tracker-hist">
                <button type="button" className={`tracker-hist__toggle ${histOpen ? 'is-open' : ''}`} onClick={() => toggleHistory(p.id)}>
                  <span className="tracker-hist__caret">▸</span>{' '}
                  {p.changelog.length ? 'Feature history — changelog + commits' : 'What’s been added — commit history'}
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
        <header className="tracker__masthead">
          <div className="tracker__top">
            <span className="tracker__eyebrow">Project Index — Vol. 1</span>
            <div className="tracker__controls">
              <button type="button" className="tracker__ctl" onClick={() => void refresh()} title="Rescan now">
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

          <div className="tracker__stats">
            <div className="tracker-stat">
              <span className="tracker-stat__num">{data ? data.totals.projects : '–'}</span>
              <span className="tracker-stat__label">Projects</span>
            </div>
            <div className="tracker-stat">
              <span className="tracker-stat__num">{data ? data.totals.groups : '–'}</span>
              <span className="tracker-stat__label">Groups</span>
            </div>
            <div className="tracker-stat">
              <span className="tracker-stat__num tracker-stat__num--accent">{data ? data.totals.openTasks : '–'}</span>
              <span className="tracker-stat__label">Open tasks</span>
            </div>
          </div>

          {data && data.groups.length > 1 && (
            <nav className="tracker-filters">
              <button type="button" className={`tracker-filter ${filter === 'all' ? 'is-on' : ''}`} onClick={() => setFilter('all')}>
                All
              </button>
              {data.groups.map((g) => (
                <button type="button" key={g.tag} className={`tracker-filter ${filter === g.tag ? 'is-on' : ''}`} onClick={() => setFilter(g.tag)}>
                  {g.label} · {g.projects.length}
                </button>
              ))}
            </nav>
          )}
        </header>

        <main className="tracker__main">
          {loading ? (
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

        {data && (
          <footer className="tracker__colophon">
            <span>
              {data.totals.repos} git repos · {data.totals.sessions} open sessions
            </span>
            <span>Grouped by your Crew session tags · click a title to expand</span>
          </footer>
        )}
      </div>
    </div>
  )
}
