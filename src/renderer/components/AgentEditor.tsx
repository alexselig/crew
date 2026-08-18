import { useEffect, useState } from 'react'
import type { Agent, Preset } from '../../shared/types'
import { validateAgent, makeAgentId } from '../../shared/agents'

interface Props {
  agent: Agent | null // null = create
  presets: Preset[]
  onSave: (a: Agent) => void
  onDelete?: (id: string) => void
  onClose: () => void
}

const ICONS = ['spark', 'check', 'shield', 'doc', 'zap', 'tag']
const COLORS = ['#c879ff', '#3fb950', '#e5a13a', '#5f79ff', '#ff7a3c', '#2b4cf2']

/** Create or edit a specialist agent. Built-ins can be duplicated ("Save as
 *  copy") but not renamed/deleted in place. */
export function AgentEditor({ agent, presets, onSave, onDelete, onClose }: Props): JSX.Element {
  // Base presets that are agent CLIs (have a brain) — copilot / claude.
  const bases = presets.filter((p) => p.id === 'copilot-cli' || p.id === 'claude-code')
  const [name, setName] = useState(agent?.name ?? '')
  const [base, setBase] = useState(agent?.base ?? bases[0]?.id ?? 'copilot-cli')
  const [icon, setIcon] = useState(agent?.icon ?? 'spark')
  const [color, setColor] = useState(agent?.color ?? COLORS[0])
  const [persona, setPersona] = useState(agent?.persona ?? '')
  const [contextMode, setContextMode] = useState<Agent['contextMode']>(agent?.contextMode ?? 'cwd')
  const [writes, setWrites] = useState(agent?.writes ?? false)
  const [error, setError] = useState<string | null>(null)
  const isBuiltin = !!agent?.builtin

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = (asCopy = false): void => {
    const draft: Agent = {
      id: !agent || asCopy ? makeAgentId() : agent.id,
      name: asCopy ? `${name} copy` : name,
      icon,
      color,
      base,
      persona,
      contextMode,
      writes,
      order: agent?.order ?? 999,
      builtin: asCopy ? false : agent?.builtin
    }
    const err = validateAgent(draft)
    if (err) {
      setError(err)
      return
    }
    onSave(draft)
    onClose()
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <form className="modal modal--agent" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); save(isBuiltin) }}>
        <h2 className="modal__title">{agent ? (isBuiltin ? `${agent.name} (built-in)` : 'Edit agent') : 'New agent'}</h2>

        <label className="field">
          <span className="field__label">Name</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} disabled={isBuiltin} autoFocus />
        </label>

        <div className="field field--row">
          <label className="field">
            <span className="field__label">Base</span>
            <select className="field__input" value={base} onChange={(e) => setBase(e.target.value)} disabled={isBuiltin}>
              {bases.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Icon</span>
            <select className="field__input" value={icon} onChange={(e) => setIcon(e.target.value)} disabled={isBuiltin}>
              {ICONS.map((i) => (<option key={i} value={i}>{i}</option>))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Color</span>
            <select className="field__input" value={color} onChange={(e) => setColor(e.target.value)} disabled={isBuiltin}>
              {COLORS.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field__label">Persona (system prompt)</span>
          <textarea className="field__input" rows={5} value={persona} onChange={(e) => setPersona(e.target.value)} disabled={isBuiltin}
            placeholder="You are a … Inspect the code in this working directory (read only) and report …" />
        </label>

        <div className="field field--row">
          <label className="field">
            <span className="field__label">Context</span>
            <select className="field__input" value={contextMode} onChange={(e) => setContextMode(e.target.value as Agent['contextMode'])} disabled={isBuiltin}>
              <option value="cwd">Working folder</option>
              <option value="cwd+transcript">Folder + recent transcript</option>
            </select>
          </label>
          <label className="field field--check">
            <input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} disabled={isBuiltin} />
            <span>Can edit files (autonomous)</span>
          </label>
        </div>

        {error && <p className="modal__warn">{error}</p>}

        <div className="modal__actions">
          {agent && !isBuiltin && onDelete && (
            <button type="button" className="btn btn--danger" onClick={() => { onDelete(agent.id); onClose() }}>
              Delete
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {isBuiltin ? (
            <button type="button" className="btn btn--primary" onClick={() => save(true)}>Save as copy</button>
          ) : (
            <button type="submit" className="btn btn--primary">Save</button>
          )}
        </div>
      </form>
    </div>
  )
}
