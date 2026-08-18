import type { Agent, AgentRun } from '../../shared/types'
import { AgentRow } from './AgentRow'

interface Props {
  agents: Agent[]
  runs: Record<string, AgentRun>
  railed: boolean
  onInvoke: (agentId: string) => void
  onAddAgent: () => void
}

/** The "Agents" shelf pinned at the bottom of the nav — a list of on-call
 *  specialists you invoke against a session, visually distinct from the roster. */
export function AgentShelf({ agents, runs, railed, onInvoke, onAddAgent }: Props): JSX.Element | null {
  if (agents.length === 0 && railed) return null
  const isRunning = (id: string): boolean =>
    Object.values(runs).some((r) => r.agentId === id && r.status === 'running')
  const ordered = [...agents].sort((a, b) => a.order - b.order)
  return (
    <section className="agent-shelf">
      {!railed && (
        <div className="agent-shelf__head">
          <span className="agent-shelf__label">Agents</span>
          <button type="button" className="agent-shelf__add" title="New agent" onClick={onAddAgent}>
            +
          </button>
        </div>
      )}
      <div className="agent-shelf__list">
        {ordered.map((a) => (
          <AgentRow key={a.id} agent={a} running={isRunning(a.id)} railed={railed} onInvoke={() => onInvoke(a.id)} />
        ))}
      </div>
    </section>
  )
}
