import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPooled, touch, focusTerminal, markPrompt, jumpToPrompt, recordInput } from '../terminal/pool'
import { quotePaths } from '../../shared/shell-quote'
import { meterInput } from '../input-meter'
import { TerminalFocusRegistry } from '../terminal-focus'
import { startPaneSession } from '../terminal/start-pane'
import { DropTracker, dragHasFiles } from '../terminal/drop-tracker'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return dragHasFiles(e.dataTransfer.types)
}

// Tracked at module scope so a DOM re-parent can restore focus. Binding follows
// engine identity because background suspension replaces the engine for the same
// session id when rendering resumes.
const focusRegistry = new TerminalFocusRegistry()

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
  // Rough per-line accumulator of what the human types, flushed to the typed
  // Transcript on Enter. Heuristic (ignores cursor movement / escape sequences).
  const lineRef = useRef('')
  // dragenter/leave fire for every child; the tracker counts them and, crucially,
  // clears outright whenever a drag ends (see terminal/drop-tracker.ts).
  const drop = useRef(new DropTracker())
  const [dragOver, setDragOver] = useState(false)

  // A drag that ends outside this pane -- cancelled with Esc, dropped on another
  // window, or simply gone from the window -- sends the pane no further events,
  // so without these the overlay would stay up and blank the terminal.
  useEffect(() => {
    const clear = (): void => setDragOver(drop.current.end())
    const onWindowDragLeave = (e: DragEvent): void => {
      // relatedTarget is null exactly when the drag leaves the window.
      if (!e.relatedTarget) clear()
    }
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('dragleave', onWindowDragLeave)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('dragleave', onWindowDragLeave)
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const p = getPooled(id)
    // A human is looking at this session now — keep it out of the retirement
    // queue ahead of terminals nobody has opened (see terminal/lru.ts).
    touch(id)
    p.engine.mount(host)

    // Remember this terminal as the focus target whenever it gains focus, so a
    // later DOM re-parent that blurs it can hand focus back (see layout effect).
    focusRegistry.bind(id, p.engine)

    let disposed = false
    const fit = (): { cols: number; rows: number } | null => {
      if (disposed) return null
      const host = hostRef.current
      if (!host) return null
      try {
        const cs = getComputedStyle(host)
        const contentH =
          host.clientHeight -
          parseFloat(cs.paddingTop || '0') -
          parseFloat(cs.paddingBottom || '0')
        const fitted = p.engine.fit(contentH)
        // null means the mount is not laid out (collapsed pane, mid-transition,
        // detached). Keep the PTY's last good size rather than resizing the
        // agent to a pane nobody can see -- the ResizeObserver fires again the
        // moment it regains a real size. See terminal/fit-guard.ts.
        if (!fitted) return null
        window.crew.resize(id, fitted.cols, fitted.rows)
        return fitted
      } catch {
        /* container not measurable yet */
        return null
      }
    }

    // Showing a real terminal is the moment a restored session needs its agent
    // running. Sessions come back asleep so a large roster costs nothing at
    // launch; opening one is what starts it -- but only after the fit above has
    // told the main process how wide this pane is, or the agent boots into a
    // terminal of the wrong width and draws its first layout for it.
    startPaneSession(id, fit, (sid) => window.crew.wake(sid))

    // Fit again after layout settles, in case the mount was not measurable yet.
    const raf = requestAnimationFrame(fit)
    // JetBrains Mono loads asynchronously; the engine measures cell height at
    // open() time, so re-fit once fonts are ready or the bottom row clips.
    void document.fonts?.ready.then(fit)
    if (focusOnMount || focusRegistry.isLastFocused(id)) p.engine.focus()

    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    // Forward keystrokes to the PTY. A carriage return means the user submitted
    // input, so drop a landmark on that row (see markPrompt) and flush the typed
    // command line to the transcript.
    const inputSub = p.engine.onInput((d) => {
      window.crew.sendInput(id, d)
      meterInput(id, d)
      if (!d.includes('\x1b')) {
        for (const ch of d) {
          if (ch === '\r' || ch === '\n') {
            recordInput(id, lineRef.current)
            lineRef.current = ''
          } else if (ch === '\x7f' || ch === '\b') {
            lineRef.current = lineRef.current.slice(0, -1)
          } else if (ch === '\x03' || ch === '\x15') {
            lineRef.current = '' // Ctrl-C / Ctrl-U clears the line
          } else if (ch >= ' ') {
            lineRef.current += ch
          }
        }
        if (lineRef.current.length > 4096) lineRef.current = lineRef.current.slice(-4096)
      } else if (d.includes('\r') || d.includes('\n')) {
        recordInput(id, lineRef.current)
        lineRef.current = ''
      }
      if (d.includes('\r') || d.includes('\n')) markPrompt(id)
    })

    // Jump-to-prompt: ⌘↑ / ⌘↓ (Ctrl on Windows/Linux) scrolls between prompt
    // landmarks. Returning false consumes the key so the shell never sees it.
    p.engine.attachKeyHandler((e) => {
      if (
        e.type === 'keydown' &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      ) {
        jumpToPrompt(id, e.key === 'ArrowUp' ? 'prev' : 'next')
        return false
      }
      return true
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
    const p = getPooled(id)
    if (focusRegistry.shouldRestore(id, p.engine.mounted, document.activeElement === document.body)) {
      p.engine.focus()
    }
  })

  function onDragEnter(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDragOver(drop.current.enter(true))
  }
  function onDragOver(e: React.DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: React.DragEvent): void {
    setDragOver(drop.current.leave(hasFiles(e)))
  }
  function onDrop(e: React.DragEvent): void {
    // Clear first, unconditionally. Returning early on a payload that does not
    // advertise files used to strand the overlay over the terminal for the rest
    // of the session. See terminal/drop-tracker.ts.
    setDragOver(drop.current.end())
    if (!hasFiles(e)) return
    e.preventDefault()
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
