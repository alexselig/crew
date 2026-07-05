import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SKILLS,
  loadFavorites,
  saveFavorites,
  loadCustomSkills,
  saveCustomSkills,
  installedToSkill,
  type Skill
} from '../skills'
import { focusTerminal } from '../terminal-pool'
import { Icon } from './Icon'

interface Props {
  sessionId: string
  /** The session's agent command (e.g. "copilot", "claude") — selects the skills directory. */
  agent?: string
}

/**
 * Skills picker. Minimized to a "⚡ Skills" chip; expands to a gallery. Favorites
 * are pinned first; users can add/remove their own skills (persisted locally).
 * Click a skill to preview its description; click again (or Invoke) to type
 * `use <skill> to ` into the session.
 */
export function SkillsBar({ sessionId, agent }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [armedId, setArmedId] = useState<string | null>(null)
  const [favorites, setFavorites] = useState<string[]>([])
  const [custom, setCustom] = useState<Skill[]>([])
  const [installed, setInstalled] = useState<Skill[]>([])
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', invoke: '', description: '' })
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setFavorites(loadFavorites())
    setCustom(loadCustomSkills())
  }, [])

  useEffect(() => setArmedId(null), [sessionId])

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!expanded) return
    function onDoc(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [expanded])

  // Load the skills actually installed for this session's agent (Copilot/Claude).
  useEffect(() => {
    let cancelled = false
    window.crew
      .listSkills(agent ?? '')
      .then((list) => {
        if (!cancelled) setInstalled(list.map(installedToSkill))
      })
      .catch(() => {
        if (!cancelled) setInstalled([])
      })
    return () => {
      cancelled = true
    }
  }, [agent])

  const favSet = useMemo(() => new Set(favorites), [favorites])
  const ordered = useMemo(() => {
    const base = installed.length ? installed : SKILLS
    const all = [...base, ...custom]
    const q = query.trim().toLowerCase()
    const filtered = q
      ? all.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(q))
      : all
    return [...filtered.filter((s) => favSet.has(s.id)), ...filtered.filter((s) => !favSet.has(s.id))]
  }, [installed, custom, favSet, query])

  const armed = ordered.find((s) => s.id === armedId) ?? null

  function invoke(skill: Skill): void {
    window.crew.sendInput(sessionId, `use ${skill.invoke} to `)
    focusTerminal(sessionId)
    setArmedId(null)
  }

  function onChip(skill: Skill): void {
    if (armedId === skill.id) invoke(skill)
    else setArmedId(skill.id)
  }

  function toggleFavorite(id: string): void {
    const next = favSet.has(id) ? favorites.filter((f) => f !== id) : [...favorites, id]
    setFavorites(next)
    saveFavorites(next)
  }

  function addSkill(): void {
    const name = form.name.trim()
    const invokeTok = (form.invoke.trim() || name).trim()
    if (!name || !invokeTok) return
    const skill: Skill = {
      id: 'custom-' + Date.now(),
      name,
      invoke: invokeTok,
      description: form.description.trim() || `Run the ${invokeTok} skill.`,
      category: 'Custom',
      custom: true
    }
    const next = [...custom, skill]
    setCustom(next)
    saveCustomSkills(next)
    setForm({ name: '', invoke: '', description: '' })
    setAdding(false)
  }

  function removeSkill(id: string): void {
    const next = custom.filter((s) => s.id !== id)
    setCustom(next)
    saveCustomSkills(next)
    if (armedId === id) setArmedId(null)
  }

  return (
    <div className={`skills-menu ${expanded ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="btn btn--outline skills-menu__toggle"
        onClick={() => {
          setExpanded((v) => !v)
          setArmedId(null)
          setAdding(false)
        }}
        aria-expanded={expanded}
        title="Skills"
      >
        <Icon name="zap" size={13} />
        Skills
      </button>

      {expanded && (
        <div className="skills-menu__panel">
          <input
            className="skills-bar__search"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter skills"
            autoFocus
          />
          <div className="skills-menu__chips">
            {ordered.map((sk) => (
              <button
                type="button"
                key={sk.id}
                className={`skill-chip ${armedId === sk.id ? 'is-armed' : ''} ${
                  favSet.has(sk.id) ? 'is-fav' : ''
                }`}
                onClick={() => onChip(sk)}
                title={sk.description}
              >
                {favSet.has(sk.id) && <span className="skill-chip__star">★</span>}
                {sk.name}
                {armedId === sk.id && <span className="skill-chip__go">↵</span>}
              </button>
            ))}
            <button
              type="button"
              className="skill-chip skill-chip--add"
              onClick={() => setAdding((v) => !v)}
              title="Add a custom skill"
            >
              ＋ Add
            </button>
          </div>

          {adding && (
            <div className="skill-add">
              <input
                className="skill-add__input"
                placeholder="Name (e.g. Deploy)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                className="skill-add__input"
                placeholder="use ___ to  (token)"
                value={form.invoke}
                onChange={(e) => setForm({ ...form, invoke: e.target.value })}
              />
              <input
                className="skill-add__input skill-add__input--desc"
                placeholder="Description (optional)"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
              <button type="button" className="btn btn--primary" onClick={addSkill} disabled={!form.name.trim()}>
                Add
              </button>
            </div>
          )}

          {armed && (
            <div className="skills-bar__desc">
              <div className="skills-bar__desc-body">
                <span className="skills-bar__desc-name">{armed.name}</span>
                <span className="skills-bar__desc-text">{armed.description}</span>
              </div>
              <button
                type="button"
                className="icon-btn"
                title={favSet.has(armed.id) ? 'Unfavorite' : 'Favorite'}
                onClick={() => toggleFavorite(armed.id)}
              >
                {favSet.has(armed.id) ? '★' : '☆'}
              </button>
              {armed.custom && (
                <button type="button" className="icon-btn" title="Remove skill" onClick={() => removeSkill(armed.id)}>
                  🗑
                </button>
              )}
              <button type="button" className="btn btn--primary skills-bar__invoke" onClick={() => invoke(armed)}>
                Invoke · “use {armed.invoke} to …”
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
