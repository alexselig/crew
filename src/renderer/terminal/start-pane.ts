/**
 * Start the agent behind a pane, in the one order that works.
 *
 * A pane must tell the main process how big it is BEFORE the agent is started,
 * because the PTY is spawned at the last size the pane reported. Waking first
 * spawns the agent at whatever size was remembered from before — for a session
 * restored from disk, the 100x30 default — and the correct width then arrives a
 * frame later, after the agent has already drawn its first layout into a grid
 * of the wrong width. That is what produces wrapped, fragmented, half-blank
 * panes.
 *
 * This is a thin function on purpose. The ordering is the entire contract, it
 * is invisible at the call site, and it has already been got wrong once, so it
 * is named and tested rather than left as two adjacent statements.
 */
export function startPaneSession(
  id: string,
  /** Fit the pane and report its size. Returns null if it cannot be measured. */
  fit: () => { cols: number; rows: number } | null,
  wake: (id: string) => void
): void {
  try {
    fit()
  } catch {
    // Not measurable yet (collapsed pane, mid-transition, detached mount). The
    // ResizeObserver fits again the moment it has a real size; starting the
    // agent at the remembered size beats not starting it at all.
  }
  wake(id)
}
