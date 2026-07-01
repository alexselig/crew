import { useEffect, useState } from 'react'
import { SKILLS, type Skill } from '../skills'
import { focusTerminal } from '../terminal-pool'

interface Props {
  sessionId: string
}

/**
 * Skills picker. Minimized to a single "⚡ Skills" chip; click it to open the
 * gallery. Click a skill to preview its description; click again (or the Invoke
 * button) to type `use <skill> to ` into the session so you can finish the ask.
 */
export function SkillsBar({ sessionId }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [armedId, setArmedId] = useState<string | null>(null)

  // Reset the preview when switching sessions.
  useEffect(() => setArmedId(null), [sessionId])

  const armed = SKILLS.find((s) => s.id === armedId) ?? null

  function invoke(skill: Skill): void {
    window.crew.sendInput(sessionId, `use ${skill.invoke} to `)
    focusTerminal(sessionId)
    setArmedId(null)
  }

  function onChip(skill: Skill): void {
    if (armedId === skill.id) invoke(skill)
    else setArmedId(skill.id)
  }

  if (!expanded) {
    return (
      <div className="skills-bar skills-bar--min">
        <button
          type="button"
          className="skill-chip skill-chip--toggle"
          onClick={() => setExpanded(true)}
          title="Open skills"
        >
          ⚡ Skills
        </button>
      </div>
    )
  }

  return (
    <div className="skills-bar">
      <div className="skills-bar__top">
        <button
          type="button"
          className="skill-chip skill-chip--toggle is-open"
          onClick={() => {
            setExpanded(false)
            setArmedId(null)
          }}
          title="Minimize"
        >
          ⚡ Skills ▾
        </button>
        <div className="skills-bar__chips">
          {SKILLS.map((sk) => (
            <button
              type="button"
              key={sk.id}
              className={`skill-chip ${armedId === sk.id ? 'is-armed' : ''}`}
              onClick={() => onChip(sk)}
              title={sk.description}
            >
              {sk.name}
              {armedId === sk.id && <span className="skill-chip__go">↵</span>}
            </button>
          ))}
        </div>
      </div>
      {armed && (
        <div className="skills-bar__desc">
          <div className="skills-bar__desc-body">
            <span className="skills-bar__desc-name">{armed.name}</span>
            <span className="skills-bar__desc-text">{armed.description}</span>
          </div>
          <button type="button" className="btn btn--primary skills-bar__invoke" onClick={() => invoke(armed)}>
            Invoke · “use {armed.invoke} to …”
          </button>
        </div>
      )}
    </div>
  )
}
