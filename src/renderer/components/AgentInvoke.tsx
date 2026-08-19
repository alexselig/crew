import { useEffect, useState } from 'react'
import type { Agent, SessionInfo } from '../../shared/types'
import { groupSessionsForPicker } from '../grouping'

interface Props {
  agent: Agent
  sessions: SessionInfo[]
  defaultSessionId: string | null
  onRun: (sessionId: string, task: string) => void
  onClose: () => void
}

/** A small modal to run a specialist against a session: pick the target session
 *  and (optionally) a specific task, then Run. */
export function AgentInvoke({ agent, sessions, defaultSessionId, onRun, onClose }: Props): JSX.Element {
  const targets = sessions.filter((s) => s.status === 'active' && s.cwd)
  // Organize the picker: grouped by group (tag) when present, else recency-sorted.
  const pickerGroups = groupSessionsForPicker(targets)
  const [sessionId, setSessionId] = useState<string>(
    defaultSessionId && targets.some((s) => s.id === defaultSessionId) ? defaultSessionId : targets[0]?.id ?? ''
  )
  const [task, setTask] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const run = (): void => {
    if (!sessionId) return
    onRun(sessionId, task)
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <form
        className="modal modal--agent"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <h2 className="modal__title">Run {agent.name}</h2>
        <p className="modal__hint modal__hint--tight">
          {agent.name} will run in the selected session’s folder and report back. It never touches your live session.
        </p>

        <label className="field">
          <span className="field__label">Run against</span>
          {targets.length === 0 ? (
            <span className="sets__empty">No active session with a project folder. Start one first.</span>
          ) : (
            <select className="field__input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {pickerGroups.map((g, i) =>
                g.name === null ? (
                  g.sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} — {s.cwd}
                    </option>
                  ))
                ) : (
                  <optgroup key={g.name + i} label={g.name}>
                    {g.sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label} — {s.cwd}
                      </option>
                    ))}
                  </optgroup>
                )
              )}
            </select>
          )}
        </label>

        <label className="field">
          <span className="field__label">Task (optional)</span>
          <textarea
            className="field__input"
            rows={3}
            placeholder={`What should ${agent.name} look at? (e.g. "the checkout flow")`}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            autoFocus
          />
        </label>

        {agent.writes && <p className="modal__warn">⚠ This agent can edit files in the folder.</p>}

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!sessionId}>
            Run
          </button>
        </div>
      </form>
    </div>
  )
}
