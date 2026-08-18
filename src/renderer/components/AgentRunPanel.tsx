import { useEffect, useRef, useState } from 'react'
import type { Agent, AgentRun } from '../../shared/types'

interface Props {
  run: AgentRun
  agent: Agent | undefined
  onCancel: () => void
  onInsert: () => void
  onSave: () => void
  onClose: () => void
}

/** A right-side drawer that streams an agent run's output and, on completion,
 *  offers Copy / Insert into session / Save to Assets. Non-blocking: you can
 *  keep working while a specialist runs. */
export function AgentRunPanel({ run, agent, onCancel, onInsert, onSave, onClose }: Props): JSX.Element {
  const outRef = useRef<HTMLPreElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  // Autoscroll to the tail as output streams in.
  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run.output])

  const copy = (): void => {
    void navigator.clipboard.writeText(run.output)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const save = (): void => {
    onSave()
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }

  const statusLabel =
    run.status === 'running' ? 'Running…' : run.status === 'done' ? 'Done' : run.error || 'Error'

  return (
    <aside className="agent-run">
      <header className="agent-run__head">
        <span className="agent-run__title">
          {agent?.name ?? 'Agent'}
          {run.task ? <span className="agent-run__task"> · {run.task}</span> : null}
        </span>
        <span className={`agent-run__status agent-run__status--${run.status}`}>
          {run.status === 'running' && <span className="agent-run__spin" aria-hidden />}
          {statusLabel}
        </span>
        <button type="button" className="agent-run__close" title="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <pre className="agent-run__out" ref={outRef}>
        {run.output || (run.status === 'running' ? 'Starting…' : '')}
      </pre>

      <footer className="agent-run__foot">
        {run.status === 'running' ? (
          <button type="button" className="btn btn--danger" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {run.sessionId && (
              <button type="button" className="btn" onClick={onInsert}>
                Insert into session
              </button>
            )}
            <button type="button" className="btn btn--primary" onClick={save}>
              {saved ? 'Saved ✓' : 'Save to Assets'}
            </button>
          </>
        )}
      </footer>
    </aside>
  )
}
