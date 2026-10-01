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
 * But resizing a PTY raises SIGWINCH, and a TUI answers SIGWINCH by redrawing
 * everything. Forwarding every fit would turn each click back into Crew into a
 * full redraw of every live agent — trading a rare mis-fit for constant churn.
 * So the size is forwarded only when it actually differs from the last one
 * reported, which makes the extra fits free and leaves SIGWINCH meaning what
 * it should: the pane really is a different shape now.
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
  /** Tell the main process, which resizes the PTY and raises SIGWINCH. */
  send: (cols: number, rows: number) => void
): FitReporter {
  let sent: Size | null = null
  return {
    report(): Size | null {
      const next = fit()
      // An unmeasurable pane is not evidence that the last reported size is
      // wrong, so it must not clear it — otherwise the next good fit would
      // report a size the PTY is already at and raise SIGWINCH for nothing.
      if (!next) return null
      if (!sent || sent.cols !== next.cols || sent.rows !== next.rows) {
        sent = next
        send(next.cols, next.rows)
      }
      return next
    }
  }
}
