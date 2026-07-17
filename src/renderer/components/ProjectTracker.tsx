import { useEffect, useMemo } from 'react'
import type { SessionInfo } from '../../shared/types'

interface Props {
  roster: SessionInfo[]
  onClose: () => void
}

interface Project {
  cwd: string
  name: string
  color: string
  group: string
  open: number
  lastActivity: number
}

interface Section {
  name: string
  projects: Project[]
}

const UNGROUPED = 'Ungrouped'

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
 * Full-screen "Project Index" tracker. This version indexes the currently *open*
 * (active) sessions: one project per working directory, grouped into sections by
 * the sessions' group tag. Launches over the normal Crew UI; ✕ or Esc closes it.
 * (The richer task-level tracker is still being built out separately.)
 */
export function ProjectTracker({ roster, onClose }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { sections, projectCount, openCount } = useMemo(() => {
    // One project per cwd, built from open (active) sessions only.
    const byCwd = new Map<string, Project>()
    for (const s of roster) {
      if (s.status !== 'active') continue
      const cur = byCwd.get(s.cwd)
      if (cur) {
        cur.open += 1
        cur.lastActivity = Math.max(cur.lastActivity, recencyOf(s))
        if (cur.group === UNGROUPED && s.tag && s.tag.trim()) cur.group = s.tag.trim()
      } else {
        byCwd.set(s.cwd, {
          cwd: s.cwd,
          name: projectName(s.cwd),
          color: s.color,
          group: s.tag && s.tag.trim() ? s.tag.trim() : UNGROUPED,
          open: 1,
          lastActivity: recencyOf(s)
        })
      }
    }
    const projects = [...byCwd.values()]

    // Group projects into sections by their group tag (most-recently-active first
    // within a section; ungrouped last).
    const bySection = new Map<string, Project[]>()
    for (const p of projects) {
      const arr = bySection.get(p.group)
      if (arr) arr.push(p)
      else bySection.set(p.group, [p])
    }
    const secs: Section[] = [...bySection.entries()]
      .map(([name, ps]) => ({
        name,
        projects: ps.sort((a, b) => b.lastActivity - a.lastActivity)
      }))
      .sort((a, b) => {
        if (a.name === UNGROUPED) return 1
        if (b.name === UNGROUPED) return -1
        return a.name.localeCompare(b.name)
      })

    return {
      sections: secs,
      projectCount: projects.length,
      openCount: projects.reduce((n, p) => n + p.open, 0)
    }
  }, [roster])

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
            <span className="tracker-stat__num">{projectCount}</span>
            <span className="tracker-stat__label">Projects</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num">{sections.length}</span>
            <span className="tracker-stat__label">Groups</span>
          </div>
          <div className="tracker-stat">
            <span className="tracker-stat__num tracker-stat__num--accent">{openCount}</span>
            <span className="tracker-stat__label">Open sessions</span>
          </div>
        </div>

        {sections.length === 0 ? (
          <div className="tracker__empty">No projects with open sessions.</div>
        ) : (
          sections.map((sec) => (
            <section className="tracker-sec" key={sec.name}>
              <div className="tracker-sec__head">
                <span className="tracker-sec__name">{sec.name}</span>
                <span className="tracker-sec__line" />
                <span className="tracker-sec__count">{sec.projects.length}</span>
              </div>
              {sec.projects.map((p) => (
                <div className="tracker-row" key={p.cwd} title={p.cwd}>
                  <span className="tracker-row__dot" style={{ background: p.color }} />
                  <span className="tracker-row__name">{p.name}</span>
                  <span className="tracker-row__open">
                    {p.open} open
                  </span>
                  <span className="tracker-row__time">{fmtAgo(p.lastActivity)}</span>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
