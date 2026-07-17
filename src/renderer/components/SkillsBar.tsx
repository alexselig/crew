import { useEffect, useMemo, useRef, useState } from 'react'
import {
  SKILLS,
  loadFavorites,
  saveFavorites,
  loadCustomSkills,
  saveCustomSkills,
  installedToSkill,
  categoryOf,
  categoryColor,
  SKILL_CATEGORY_ORDER,
  type Skill
} from '../skills'
import { focusTerminal } from '../terminal-pool'
import { Icon } from './Icon'

interface Props {
  sessionId: string
  /** The session's agent command (e.g. "copilot", "claude") — selects the skills directory. */
  agent?: string
}

/** A colored initial-swatch for a skill, tinted by its category. */
function Swatch({ skill }: { skill: Skill }): JSX.Element {
  const initial = skill.name.trim()[0]?.toUpperCase() ?? '?'
  return (
    <span className="skills-swatch" style={{ background: categoryColor(categoryOf(skill)) }} aria-hidden="true">
      {initial}
    </span>
  )
}

/**
 * Skills picker. Minimized to a "⚡ Skills" chip; expands to a categorized,
 * searchable, favoritable list that matches Crew's design system. Clicking a
 * skill selects it (opening a description footer with an INVOKE action);
 * favorites pin to a row at the top. Users can add/remove their own skills
 * (persisted locally). Invoking types `use <skill> to ` into the session.
 */
export function SkillsBar({ sessionId, agent }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  useEffect(() => setSelectedId(null), [sessionId])

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
  const allSkills = useMemo(
    () => [...(installed.length ? installed : SKILLS), ...custom],
    [installed, custom]
  )

  const q = query.trim().toLowerCase()
  const matches = (s: Skill): boolean =>
    !q || s.name.toLowerCase().includes(q) || s.invoke.toLowerCase().includes(q)

  // Group the (filtered) skills into ordered, non-empty category sections.
  const categories = useMemo(() => {
    const byCat = new Map<string, Skill[]>()
    for (const s of allSkills) {
      if (!matches(s)) continue
      const c = categoryOf(s)
      const arr = byCat.get(c)
      if (arr) arr.push(s)
      else byCat.set(c, [s])
    }
    return SKILL_CATEGORY_ORDER.map((name) => ({ name, skills: byCat.get(name) ?? [] })).filter(
      (c) => c.skills.length > 0
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSkills, q])

  const favoriteSkills = useMemo(
    () => allSkills.filter((s) => favSet.has(s.id)),
    [allSkills, favSet]
  )

  const totalMatches = categories.reduce((n, c) => n + c.skills.length, 0)
  const noResults = q.length > 0 && totalMatches === 0
  const selected = allSkills.find((s) => s.id === selectedId) ?? null

  function invoke(skill: Skill): void {
    window.crew.sendInput(sessionId, `use ${skill.invoke} to `)
    focusTerminal(sessionId)
    setSelectedId(null)
    setExpanded(false)
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
    if (selectedId === id) setSelectedId(null)
  }

  return (
    <div className={`skills-menu ${expanded ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="btn btn--outline skills-menu__toggle"
        onClick={() => {
          setExpanded((v) => !v)
          setSelectedId(null)
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
          <div className="skills-panel__search">
            <input
              className={`skills-panel__input ${q ? 'is-active' : ''}`}
              placeholder="Filter skills…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter skills"
              autoFocus
            />
          </div>

          <div className="skills-panel__body">
            {favoriteSkills.length > 0 && !q && (
              <div className="skills-cat">
                <div className="skills-cat__label skills-cat__label--fav">★ Favorites</div>
                <div className="skills-favrow">
                  {favoriteSkills.map((sk) => (
                    <button
                      type="button"
                      key={sk.id}
                      className="skills-favchip"
                      onClick={() => setSelectedId(sk.id)}
                      title={sk.description}
                    >
                      <Swatch skill={sk} />
                      {sk.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {categories.map((cat) => (
              <div className="skills-cat" key={cat.name}>
                <div className="skills-cat__label">{cat.name}</div>
                <div className="skills-cat__rows">
                  {cat.skills.map((sk) => (
                    <button
                      type="button"
                      key={sk.id}
                      className={`skills-row ${selectedId === sk.id ? 'is-selected' : ''}`}
                      onClick={() => setSelectedId(sk.id)}
                      title={sk.description}
                    >
                      <Swatch skill={sk} />
                      <span className="skills-row__name">{sk.name}</span>
                      <span
                        className={`skills-row__star ${favSet.has(sk.id) ? 'is-fav' : ''}`}
                        role="button"
                        aria-label={favSet.has(sk.id) ? 'Unfavorite' : 'Favorite'}
                        title={favSet.has(sk.id) ? 'Unfavorite' : 'Favorite'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFavorite(sk.id)
                        }}
                      >
                        {favSet.has(sk.id) ? '★' : '☆'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {noResults && <div className="skills-empty">No skills match “{query}”</div>}

            {adding ? (
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
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={addSkill}
                  disabled={!form.name.trim()}
                >
                  Add
                </button>
              </div>
            ) : (
              <button type="button" className="skills-addlink" onClick={() => setAdding(true)}>
                ＋ Add a custom skill
              </button>
            )}
          </div>

          {selected && (
            <div className="skills-panel__footer">
              <Swatch skill={selected} />
              <div className="skills-panel__footer-text">
                <div className="skills-panel__footer-name">{selected.name}</div>
                <div className="skills-panel__footer-desc">{selected.description}</div>
              </div>
              {selected.custom && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Remove skill"
                  onClick={() => removeSkill(selected.id)}
                >
                  🗑
                </button>
              )}
              <button type="button" className="skills-invoke" onClick={() => invoke(selected)}>
                INVOKE
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
