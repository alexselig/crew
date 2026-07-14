import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getPooled, focusTerminal, markPrompt } from '../terminal-pool'
import { quotePaths } from '../../shared/shell-quote'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

/**
 * Mounts a pooled xterm terminal into the visible pane. The terminal instance
 * itself lives in the pool for the session's whole lifetime; here we just
 * (re)attach its DOM element, keep it fitted to the container, and forward
 * keystrokes to the PTY.
 *
 * Files dropped from Finder are inserted as shell-quoted paths at the agent's
 * prompt (e.g. drop a screenshot into Claude Code).
 */
export function TerminalView({
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

    // Forward keystrokes to the PTY. A carriage return means the user submitted
    // input, so drop a yellow landmark on that row (see markPrompt). Pasting
    // multi-line text can also carry a newline; an occasional extra mark is
    // harmless for a spotting aid.
    const dataSub = p.term.onData((d) => {
      window.crew.sendInput(id, d)
      if (d.includes('\r') || d.includes('\n')) markPrompt(id)
    })

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
