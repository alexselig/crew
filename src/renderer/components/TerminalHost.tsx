import { TerminalView } from './TerminalView'
import { CrewTerminal } from './CrewTerminal'

/**
 * Chooses the terminal implementation for a session. When the app-wide "Beta
 * Enhanced Terminal Interface" setting is on, every session renders the new
 * Crew engine (CrewTerminal); otherwise the legacy xterm view (TerminalView).
 * Because the two are different component types, flipping `enhanced` cleanly
 * unmounts one and mounts the other.
 *
 * This deliberately does NOT unmount on window blur. It used to, as a
 * background-cost saving, but the terminal subtree owns the session's file-drop
 * target and its scroll position, and blur is the normal state for both: you
 * cannot drag a file out of Finder without Crew losing focus, and glancing at
 * another app mid-scroll should not reset the pane. The pools still release
 * *unmounted* terminals when the app goes inactive, which is where the cost
 * was.
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
  return enhanced ? (
    <CrewTerminal id={id} focusOnMount={focusOnMount} />
  ) : (
    <TerminalView id={id} focusOnMount={focusOnMount} />
  )
}
