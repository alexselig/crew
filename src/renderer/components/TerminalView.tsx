import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getPooled, focusTerminal, markPrompt } from '../terminal-pool'
import { quotePaths } from '../../shared/shell-quote'

/** True when the drag payload contains OS files (not an internal card drag). */
function hasFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
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
    const fit = (): void => {
      if (disposed) return
      const host = hostRef.current
      if (!host) return
      try {
        p.fit.fit()
        // FitAddon subtracts padding measured on the .xterm element, but ours
        // lives on the parent .term-mount (border-box), so it proposes one row too
        // many and the bottom row (the input prompt / footer) gets clipped by the
        // tile edge. Cap rows to the mount's true content height so the last row
        // is always fully visible.
        const cellH = cellHeightOf(p.term as unknown as { _core?: unknown })
        if (cellH > 0) {
          const cs = getComputedStyle(host)
          const contentH =
            host.clientHeight - parseFloat(cs.paddingTop || '0') - parseFloat(cs.paddingBottom || '0')
          const maxRows = Math.max(1, Math.floor(contentH / cellH))
          if (p.term.rows > maxRows) p.term.resize(p.term.cols, maxRows)
        }
        window.crew.resize(id, p.term.cols, p.term.rows)
      } catch {
        /* container not measurable yet */
      }
    }

    // Fit after layout settles.
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
