import { useEffect, useState } from 'react'
import type { SessionSet } from '../../shared/types'
import { SessionSetChips } from './SessionSetChips'
import { readViewPref } from '../window-scope'

/**
 * The workspace currently being filtered to, as create-session arguments.
 * Resumed sessions join it for the same reason new ones do: a session that
 * lands outside the active filter is invisible, and the click reads as a no-op.
 */
function activeWorkspaceIds(): string[] {
  const id = readViewPref('activeWorkspace')
  return id ? [id] : []
}

/**
 * Launch-screen affordance shown in the empty state: resume a saved set of
 * sessions with one click. Renders nothing until at least one set exists, so a
 * fresh install still shows only the "New Session" button.
 */
export function ResumeSets(): JSX.Element | null {
  const [sets, setSets] = useState<SessionSet[]>([])
  useEffect(() => {
    void window.crew.getSets().then(setSets)
  }, [])
  if (sets.length === 0) return null
  return (
    <div className="empty__resume">
      <span className="empty__resume-label">Resume a set</span>
      <SessionSetChips sets={sets} onLaunch={(name) => void window.crew.launchSet(name, activeWorkspaceIds())} />
    </div>
  )
}
