import { GithubButton } from './GithubButton'
import { SkillsBar } from './SkillsBar'

/** App-wide GitHub-chip settings, threaded from Settings. */
export interface GithubButtonSettings {
  /** Whether to show the GitHub chip at all. */
  show: boolean
  /** Whether clicking also opens the repo (vs only copying the URL). */
  opensRepo: boolean
}

interface Props {
  sessionId: string
  /** The session's agent command (selects the skills directory). */
  agent?: string
  /** The session's working directory (used to resolve its GitHub remote). */
  cwd: string
  /** GitHub chip behavior from Settings; defaults to shown + opens-repo. */
  githubButton?: GithubButtonSettings
  /** In the grid, stop clicks from bubbling to the tile (which would focus it). */
  isolateClicks?: boolean
}

/**
 * The floating tool cluster pinned to the top-right of a session terminal: the
 * GitHub repo chip (shown only when enabled in Settings and the session has a
 * GitHub remote) beside the Skills button. Shared by the focused SessionView and
 * the grid tiles.
 */
export function SessionTools({ sessionId, agent, cwd, githubButton, isolateClicks }: Props): JSX.Element {
  const gh = githubButton ?? { show: true, opensRepo: true }
  return (
    <div
      className="session-tools"
      onClick={isolateClicks ? (e) => e.stopPropagation() : undefined}
    >
      {gh.show && <GithubButton cwd={cwd} opensRepo={gh.opensRepo} />}
      <SkillsBar sessionId={sessionId} agent={agent} />
    </div>
  )
}
