import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPooled, touch, focusTerminal, markPrompt } from '../terminal-pool'
import { quotePaths } from '../../shared/shell-quote'
import { meterInput } from '../input-meter'
import { decideFit } from '../terminal/fit-guard'
import { startPaneSession } from '../terminal/start-pane'
import { DropTracker, dragHasFiles } from '../terminal/drop-tracker'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return dragHasFiles(e.dataTransfer.types)
}

/** xterm's rendered cell height in CSS px (from its render service), or 0 when
 *  not yet measured. Reaches into xterm internals (as FitAddon itself does);
 *  guarded so a shape change just disables the row cap rather than throwing. */
function cellHeightOf(term: { _core?: unknown }): number {
  const dims = (term._core as { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } })
    ?._renderService?.dimensions?.css?.cell?.height
  return typeof dims === 'number' && dims > 0 ? dims : 0
}

// The session whose terminal was last focused. Tracked at module scope so we can
// restore focus after a DOM re-parent (grid reorder / regrouping / view swap)
// silently blurs xterm's hidden textarea — which otherwise leaves the terminal
// unable to accept input until the user toggles views. `focusBound` ensures we
// attach the focus listener to each pooled terminal only once.
let lastFocusedTerminal: string | null = null
const focusBound = new WeakSet<object>()

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
    if (!p.opened) {
      p.term.open(host)
      p.opened = true
    } else if (p.term.element) {
      host.appendChild(p.term.element)
    }

    // Remember this terminal as the focus target whenever it gains focus, so a
    // later DOM re-parent that blurs it can hand focus back (see the layout
    // effect below). Bound once per pooled terminal.
    if (p.term.textarea && !focusBound.has(p.term)) {
      p.term.textarea.addEventListener('focus', () => {
        lastFocusedTerminal = id
      })
      focusBound.add(p.term)
    }

    let disposed = false
    const fit = (): { cols: number; rows: number } | null => {
      if (disposed) return null
      const host = hostRef.current
      if (!host) return null
      try {
        // Never call p.fit.fit() -- it applies its own proposal before anyone
        // can inspect it, and a proposal read from a collapsed mount is a
        // plausible 2 columns / 1 row rather than an obvious error. Iterate to
        // a fixed point because FitAddon's scrollbar-width term does not
        // converge in one pass. See terminal/fit-guard.ts.
        const cs = getComputedStyle(host)
        const contentH =
          host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')
        const box = {
          connected: host.isConnected,
          clientWidth: host.clientWidth,
          clientHeight: host.clientHeight
        }
        let applied: { cols: number; rows: number } | null = null
        for (let pass = 0; pass < 3; pass++) {
          const next = decideFit({
            proposed: p.fit.proposeDimensions(),
            host: box,
            contentHeightPx: contentH,
            cellHeightPx: cellHeightOf(p.term as unknown as { _core?: unknown })
          })
          if (!next) return null
          applied = next
          if (p.term.cols === next.cols && p.term.rows === next.rows) break
          p.term.resize(next.cols, next.rows)
        }
        if (!applied) return null
        window.crew.resize(id, applied.cols, applied.rows)
        return applied
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
    // The monospace web font (JetBrains Mono) loads asynchronously; xterm measures
    // its cell height at open() time, so when the real font swaps in, the row
    // count computed against the fallback metrics is stale and the tile clips the
    // bottom row (the input prompt / footer gets bisected). The ResizeObserver
    // below won't catch this — the container didn't resize — so re-fit once fonts
    // are ready. Harmless no-op when the font is already loaded.
    void document.fonts?.ready.then(fit)
    // Focus on an explicit mount request, or when re-attaching the terminal that
    // was focused before a remount (e.g. a tile moving between group columns).
    if (focusOnMount || lastFocusedTerminal === id) p.term.focus()

    const ro = new ResizeObserver(() => fit())
    ro.observe(host)

    // Forward keystrokes to the PTY. A carriage return means the user submitted
    // input, so drop a yellow landmark on that row (see markPrompt). Pasting
    // multi-line text can also carry a newline; an occasional extra mark is
    // harmless for a spotting aid.
    const dataSub = p.term.onData((d) => {
      window.crew.sendInput(id, d)
      meterInput(id, d)
      if (d.includes('\r') || d.includes('\n')) markPrompt(id)
    })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      dataSub.dispose()
      // Detach (but do NOT dispose) so scrollback survives tab switches.
      if (p.term.element && p.term.element.parentElement === host) {
        host.removeChild(p.term.element)
      }
    }
  }, [id, focusOnMount])

  // Reordering tiles within a group re-parents the terminal's DOM node via
  // React reconciliation (no remount, so the effect above doesn't run) which
  // blurs xterm's textarea. Runs on every render: if this was the focused
  // terminal and focus fell to <body> (i.e. lost to a re-parent, not handed to
  // a real control the user clicked), reclaim it — so input keeps working
  // without having to toggle views.
  useLayoutEffect(() => {
    if (lastFocusedTerminal !== id) return
    const p = getPooled(id)
    if (
      p.opened &&
      p.term.element?.isConnected &&
      document.activeElement === document.body
    ) {
      p.term.focus()
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
    // Clear first, unconditionally -- returning early on a payload that does
    // not advertise files used to strand the overlay over the terminal for the
    // rest of the session. See terminal/drop-tracker.ts.
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
