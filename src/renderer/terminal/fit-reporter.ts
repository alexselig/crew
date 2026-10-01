/**
 * Deciding when a pane's measured size is worth telling the PTY about.
 *
 * A pane fits itself far more often than it changes size: on mount, after the
 * first frame, once fonts load, on every ResizeObserver callback, and — since
 * a wrong-but-plausible fit is otherwise never revisited — every time the
 * window comes to the front.
 *
 * Only the last of those is new, and it is the one that needs this. The
 * ResizeObserver fires when the host's size CHANGES, so a pane fitted during a
 * transition keeps that width for the rest of the run and the agent keeps
 * drawing its layout to it: a narrow column of text in a wide pane, with the
 * status line stranded where the old edge used to be. Re-fitting when the
 * window is focused heals that, because by then the layout has certainly
 * settled.
 *
 * But every fit that is forwarded crosses the IPC boundary to the main process,
 * and a dozen live panes re-fitting on every focus is a dozen messages for an
 * answer that is almost always the same one. The kernel would not punish us for
 * it -- TIOCSWINSZ compares the new winsize against the stored one and raises
 * no SIGWINCH when they match, and SessionManager.resize() already gates its
 * persist write on an actual change -- so this is about keeping the chatter
 * proportionate to the news, not about protecting agents from redraws.
 *
 * The cost of that is a renderer-side mirror of main-process state, and a
 * mirror can go stale. It is accurate today because nothing else moves a
 * session's size behind this reporter's back: repair() restores the same width
 * it started from, spawn uses the recorded size, and the one other caller of
 * window.crew.resize is the legacy terminal component, which never renders for
 * a session this one is rendering. If a second writer to the same PTY ever
 * appears, this dedupe must go: its failure mode is the bad one, suppressing a
 * size the PTY is not actually at.
 */

export interface Size {
  cols: number
  rows: number
}

export interface FitReporter {
  /**
   * Measure, and forward the result only if it differs from the last size
   * reported. Returns the measured size, or null when it was not measurable.
   */
  report(): Size | null
}

export function createFitReporter(
  /** Measure the pane. Returns null when the mount is not laid out. */
  fit: () => Size | null,
  /** Tell the main process, which resizes the PTY. */
  send: (cols: number, rows: number) => void
): FitReporter {
  let sent: Size | null = null
  return {
    report(): Size | null {
      const next = fit()
      // An unmeasurable pane is not evidence that the last reported size is
      // wrong, so it must not clear it -- otherwise the next good fit would
      // look like news when the PTY is already at that size.
      if (!next) return null
      if (!sent || sent.cols !== next.cols || sent.rows !== next.rows) {
        sent = next
        send(next.cols, next.rows)
      }
      return next
    }
  }
}
