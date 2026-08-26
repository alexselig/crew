import { useEffect, useRef, useState } from 'react'
import { previewText } from '../terminal/facade'

/**
 * True once the element is at (or near) the viewport, and false again when it
 * leaves. `rootMargin` deliberately overshoots the viewport so a tile is ready
 * before it is scrolled into view rather than popping in.
 *
 * Falls back to "always visible" where IntersectionObserver is unavailable —
 * degrading to the old always-mounted behaviour is correct, if expensive.
 */
export function useInViewport(rootMargin = '400px'): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => setInView(entries[0]?.isIntersecting ?? false), {
      rootMargin
    })
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])

  return [ref, inView]
}

/**
 * What a grid tile shows instead of a terminal while it is scrolled out of view:
 * the last few lines of the session's output as inert text.
 *
 * A live emulator per tile is what made a large roster unusable — sixty of them
 * parse and repaint continuously because agents stream output even when idle,
 * and only eight can hold a WebGL context, so the rest fall back to the DOM
 * renderer and repaint a <span>-per-run grid on every chunk. The session keeps
 * running and its output keeps accruing; only the emulator is withheld.
 */
export function TerminalPreview({ id }: { id: string }): JSX.Element {
  const [lines, setLines] = useState<string[]>(() => previewText(id, 12))

  useEffect(() => {
    // Poll rather than subscribe: this is a thumbnail for a pane nobody is
    // reading, so a slow refresh is the point.
    const t = setInterval(() => setLines(previewText(id, 12)), 1500)
    return () => clearInterval(t)
  }, [id])

  return (
    <pre className="tile__preview" aria-label="Recent output">
      {lines.join('\n')}
    </pre>
  )
}
