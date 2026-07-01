import { useEffect, useRef } from 'react'
import { getPooled } from '../terminal-pool'

/**
 * Mounts a pooled xterm terminal into the visible pane. The terminal instance
 * itself lives in the pool for the session's whole lifetime; here we just
 * (re)attach its DOM element, keep it fitted to the container, and forward
 * keystrokes to the PTY.
 */
export function TerminalView({
  id,
  focusOnMount = true
}: {
  id: string
  focusOnMount?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = getPooled(id)

    if (!p.opened) {
      p.term.open(host)
      p.opened = true
    } else if (p.term.element) {
      host.appendChild(p.term.element)
    }

    const fit = (): void => {
      try {
        p.fit.fit()
        window.crew.resize(id, p.term.cols, p.term.rows)
      } catch {
        /* container not measurable yet */
      }
    }

    // Fit after layout settles.
    const raf = requestAnimationFrame(fit)
    if (focusOnMount) p.term.focus()

    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    const dataSub = p.term.onData((d) => window.crew.sendInput(id, d))

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      dataSub.dispose()
      // Detach (but do NOT dispose) so scrollback survives tab switches.
      if (p.term.element && p.term.element.parentElement === host) {
        host.removeChild(p.term.element)
      }
    }
  }, [id, focusOnMount])

  return <div className="term-mount" ref={hostRef} />
}
