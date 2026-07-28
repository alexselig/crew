import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPooled, focusTerminal, markPrompt } from '../terminal/pool'
import { quotePaths } from '../../shared/shell-quote'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

// The session whose terminal was last focused. Tracked at module scope so we can
// restore focus after a DOM re-parent (grid reorder / regrouping / view swap)
// silently blurs the terminal's hidden textarea — which otherwise leaves it
// unable to accept input until the user toggles views. `focusBound` ensures we
// attach the focus listener to each pooled engine only once.
let lastFocusedTerminal: string | null = null
const focusBound = new Set<string>()

/**
 * The Crew-engine terminal view (used when "Beta Enhanced Terminal Interface" is
 * on). Mirrors TerminalView's behaviour exactly — (re)attach a pooled engine,
 * keep it fitted, forward keystrokes, drop prompt landmarks, insert dropped file
 * paths — but talks to Crew's TerminalEngine interface instead of xterm directly.
 */
export function CrewTerminal({
  id,
  focusOnMount = true
}: {
  id: string
  focusOnMount?: boolean
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  // dragenter/leave fire for every child; a depth counter avoids flicker.
  const depth = useRef(0)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = getPooled(id)
    p.engine.mount(host)

    // Remember this terminal as the focus target whenever it gains focus, so a
    // later DOM re-parent that blurs it can hand focus back (see layout effect).
    if (!focusBound.has(id)) {
      p.engine.onFocus(() => {
        lastFocusedTerminal = id
      })
      focusBound.add(id)
    }

    let disposed = false
    const fit = (): void => {
      if (disposed) return
      const host = hostRef.current
      if (!host) return
      try {
        const cs = getComputedStyle(host)
        const contentH =
          host.clientHeight -
          parseFloat(cs.paddingTop || '0') -
          parseFloat(cs.paddingBottom || '0')
        const { cols, rows } = p.engine.fit(contentH)
        window.crew.resize(id, cols, rows)
      } catch {
        /* container not measurable yet */
      }
    }

    // Fit after layout settles.
    const raf = requestAnimationFrame(fit)
    // JetBrains Mono loads asynchronously; the engine measures cell height at
    // open() time, so re-fit once fonts are ready or the bottom row clips.
    void document.fonts?.ready.then(fit)
    if (focusOnMount || lastFocusedTerminal === id) p.engine.focus()

    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    // Forward keystrokes to the PTY. A carriage return means the user submitted
    // input, so drop a landmark on that row (see markPrompt).
    const inputSub = p.engine.onInput((d) => {
      window.crew.sendInput(id, d)
      if (d.includes('\r') || d.includes('\n')) markPrompt(id)
    })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      inputSub.dispose()
      // Detach (but do NOT dispose) so scrollback survives tab switches.
      p.engine.unmount(host)
    }
  }, [id, focusOnMount])

  // Reordering tiles within a group re-parents the terminal's DOM node via React
  // reconciliation (no remount) which blurs the textarea. Runs on every render:
  // if this was the focused terminal and focus fell to <body>, reclaim it — so
  // input keeps working without having to toggle views.
  useLayoutEffect(() => {
    if (lastFocusedTerminal !== id) return
    const p = getPooled(id)
    if (p.engine.mounted && document.activeElement === document.body) {
      p.engine.focus()
    }
  })

  function onDragEnter(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current++
    setDragOver(true)
  }
  function onDragOver(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragOver(false)
  }
  function onDrop(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current = 0
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.crew.pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    // Trailing space so the user (or agent) can keep typing right after.
    window.crew.sendInput(id, quotePaths(paths) + ' ')
    focusTerminal(id)
  }

  return (
    <div
      className="term-drop"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="term-mount" ref={hostRef} />
      {dragOver && (
        <div className="term-drop__overlay">
          <span className="term-drop__hint">Drop to insert file path</span>
        </div>
      )}
    </div>
  )
}
