import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, SessionState } from '../../shared/types'
import { STATE_META, stateRank } from '../state-meta'
import { Icon } from './Icon'

interface Props {
  roster: SessionInfo[]
  onClose: () => void
}

interface Project {
  cwd: string
  name: string
  color: string
  group: string
  sessions: SessionInfo[]
  open: number
  openTasks: number
  lastActivity: number
}

interface Section {
  name: string
  projects: Project[]
}

interface Index {
  sections: Section[]
  projects: Project[]
  projectCount: number
  openTaskCount: number
}

const UNGROUPED = 'Ungrouped'

// An "open task" is a session that still has work in flight or is blocked on the
// human. IDLE (and the non-active states) means there's nothing left to do right
// now, so those don't count.
const OPEN_TASK_STATES: SessionState[] = ['STARTING', 'WORKING', 'WAITING_INPUT', 'WAITING_APPROVAL']
const hasOpenTask = (s: SessionInfo): boolean =>
  s.status === 'active' && OPEN_TASK_STATES.includes(s.state)

/** Last path segment of a working directory — the project's display name. */
function projectName(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

function recencyOf(s: SessionInfo): number {
  return s.lastPromptAt ?? s.createdAt
}

function fmtAgo(ms: number): string {
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Build the project index from the currently open (active) sessions: one project
 * per working directory, grouped into sections by the sessions' group tag. Each
 * project tracks its sessions and how many still have an open task.
 */
function buildIndex(roster: SessionInfo[]): Index {
  const byCwd = new Map<string, Project>()
  for (const s of roster) {
    if (s.status !== 'active') continue
    let cur = byCwd.get(s.cwd)
    if (!cur) {
      cur = {
        cwd: s.cwd,
        name: projectName(s.cwd),
        color: s.color,
        group: s.tag && s.tag.trim() ? s.tag.trim() : UNGROUPED,
        sessions: [],
        open: 0,
        openTasks: 0,
        lastActivity: 0
      }
      byCwd.set(s.cwd, cur)
    }
    cur.sessions.push(s)
    cur.open += 1
    if (hasOpenTask(s)) cur.openTasks += 1
    cur.lastActivity = Math.max(cur.lastActivity, recencyOf(s))
    if (cur.group === UNGROUPED && s.tag && s.tag.trim()) cur.group = s.tag.trim()
  }

  const projects = [...byCwd.values()]
  for (const p of projects) {
    // Who needs you first, then who's busy, then the rest.
    p.sessions.sort((a, b) => stateRank(a.state) - stateRank(b.state) || recencyOf(b) - recencyOf(a))
  }

  const bySection = new Map<string, Project[]>()
  for (const p of projects) {
    const arr = bySection.get(p.group)
    if (arr) arr.push(p)
    else bySection.set(p.group, [p])
  }
  const sections: Section[] = [...bySection.entries()]
    .map(([name, ps]) => ({
      name,
      // Projects with open work float to the top of their section, then by recency.
      projects: ps.sort(
        (a, b) => Number(b.openTasks > 0) - Number(a.openTasks > 0) || b.lastActivity - a.lastActivity
      )
    }))
    .sort((a, b) => {
      if (a.name === UNGROUPED) return 1
      if (b.name === UNGROUPED) return -1
      return a.name.localeCompare(b.name)
    })

  return {
    sections,
    projects,
    projectCount: projects.length,
    openTaskCount: projects.reduce((n, p) => n + p.openTasks, 0)
  }
}

/**
 * Full-screen "Project Index" tracker. Indexes the currently open (active)
 * sessions as projects (one per working directory) grouped into sections by tag.
 * Each project row expands to reveal its sessions; projects that still have an
 * open task (a session working or waiting on you) are expanded by default.
 * Launches over the normal Crew UI; ✕ or Esc closes it.
 */
export function ProjectTracker({ roster, onClose }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const index = useMemo(() => buildIndex(roster), [roster])

  // Default open state: expand every project that has an open task left to
  // complete. Computed once when the tracker opens; the user can then toggle
  // freely without rows re-expanding under them as session states change.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>()
    for (const p of index.projects) if (p.openTasks > 0) s.add(p.cwd)
    return s
  })
  const toggle = (cwd: string): void =>
    setExpanded((prev) => {
      const n = new Set(prev)
      if (n.has(cwd)) n.delete(cwd)
      else n.add(cwd)
      return n
    })

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
            <span className="tracker-stat__num">{index.projectCount}</span>
            <span className="tracker-stat__label">Projects</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num">{index.sections.length}</span>
            <span className="tracker-stat__label">Groups</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num tracker-stat__num--accent">{index.openTaskCount}</span>
            <span className="tracker-stat__label">Open tasks</span>
          </div>
        </div>

        {index.sections.length === 0 ? (
          <div className="tracker__empty">No projects with open sessions.</div>
        ) : (
          index.sections.map((sec) => (
            <section className="tracker-sec" key={sec.name}>
              <div className="tracker-sec__head">
                <span className="tracker-sec__name">{sec.name}</span>
                <span className="tracker-sec__line" />
                <span className="tracker-sec__count">{sec.projects.length}</span>
              </div>
              {sec.projects.map((p) => {
                const isOpen = expanded.has(p.cwd)
                return (
                  <div className={`tracker-proj ${isOpen ? 'is-open' : ''}`} key={p.cwd}>
                    <button
                      type="button"
                      className="tracker-row"
                      onClick={() => toggle(p.cwd)}
                      title={p.cwd}
                      aria-expanded={isOpen}
                    >
                      <span className="tracker-row__chevron">
                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                      </span>
                      <span className="tracker-row__dot" style={{ background: p.color }} />
                      <span className="tracker-row__name">{p.name}</span>
                      {p.openTasks > 0 ? (
                        <span className="tracker-row__open">
                          {p.openTasks} open task{p.openTasks > 1 ? 's' : ''}
                        </span>
                      ) : (
                        <span className="tracker-row__open tracker-row__open--idle">idle</span>
                      )}
                      <span className="tracker-row__time">{fmtAgo(p.lastActivity)}</span>
                    </button>
                    {isOpen && (
                      <div className="tracker-sessions">
                        {p.sessions.map((s) => {
                          const meta = STATE_META[s.state]
                          return (
                            <div className="tracker-sess" key={s.id}>
                              <span className="tracker-sess__dot" style={{ background: s.color }} />
                              <span className="tracker-sess__name">{s.label}</span>
                              <span className={`tracker-sess__state tone-${meta.tone}`}>{meta.label}</span>
                              <span className="tracker-sess__time">{fmtAgo(recencyOf(s))}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
