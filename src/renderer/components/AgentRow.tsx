import type { Agent } from '../../shared/types'
import { Icon } from './Icon'

interface Props {
  agent: Agent
  running: boolean
  railed: boolean
  onInvoke: () => void
}

/** One specialist in the nav Agents shelf: a distinct tinted icon + name, with a
 *  spinner while a run is in flight and a dot when the agent can edit files. */
export function AgentRow({ agent, running, railed, onInvoke }: Props): JSX.Element {
  return (
    <button
      type="button"
      className={`agent-row ${running ? 'is-running' : ''}`}
      title={railed ? `${agent.name} — run against a session` : agent.name}
      onClick={onInvoke}
    >
      <span className="agent-row__icon" style={{ color: agent.color }}>
        <Icon name={(agent.icon as Parameters<typeof Icon>[0]['name']) || 'spark'} size={16} />
      </span>
      {!railed && <span className="agent-row__name">{agent.name}</span>}
      {!railed && agent.writes && <span className="agent-row__write" title="Can edit files" aria-hidden />}
      {running && <span className="agent-row__spin" aria-hidden />}
    </button>
  )
}
