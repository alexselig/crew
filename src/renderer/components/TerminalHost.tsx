import { TerminalView } from './TerminalView'
import { CrewTerminal } from './CrewTerminal'
import { useAppActivity } from '../app-activity'

/**
 * Chooses the terminal implementation for a session. When the app-wide "Beta
 * Enhanced Terminal Interface" setting is on, every session renders the new
 * Crew engine (CrewTerminal); otherwise the legacy xterm view (TerminalView).
 * Because the two are different component types, flipping `enhanced` cleanly
 * unmounts one and mounts the other.
 */
export function TerminalHost({
  id,
  enhanced,
  focusOnMount = true
}: {
  id: string
  enhanced: boolean
  focusOnMount?: boolean
}): JSX.Element {
  const active = useAppActivity()
  if (!active) return <div className="term-mount term-mount--suspended" aria-hidden="true" />

  return enhanced ? (
    <CrewTerminal id={id} focusOnMount={focusOnMount} />
  ) : (
    <TerminalView id={id} focusOnMount={focusOnMount} />
  )
}
