import { GithubButton } from './GithubButton'
import { SkillsBar } from './SkillsBar'

interface Props {
  sessionId: string
  /** The session's agent command (selects the skills directory). */
  agent?: string
  /** The session's working directory (used to resolve its GitHub remote). */
  cwd: string
  /** In the grid, stop clicks from bubbling to the tile (which would focus it). */
  isolateClicks?: boolean
}

/**
 * The floating tool cluster pinned to the top-right of a session terminal: the
 * GitHub repo chip (shown only when the session has a GitHub remote) beside the
 * Skills button. Shared by the focused SessionView and the grid tiles.
 */
export function SessionTools({ sessionId, agent, cwd, isolateClicks }: Props): JSX.Element {
  return (
    <div
      className="session-tools"
      onClick={isolateClicks ? (e) => e.stopPropagation() : undefined}
    >
      <GithubButton cwd={cwd} />
      <SkillsBar sessionId={sessionId} agent={agent} />
    </div>
  )
}
