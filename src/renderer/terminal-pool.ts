// A renderer-side pool of xterm terminals — one per session, kept alive for the
// whole session lifetime so scrollback and PTY state survive tab switches. The
// visible <TerminalView> imperatively (re)attaches the terminal's DOM element;
// output is written here regardless of whether the session is currently shown.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface Pooled {
  term: Terminal
  fit: FitAddon
  opened: boolean
}

const pool = new Map<string, Pooled>()
// Ids of sessions whose terminals have been disposed. A killed PTY can emit one
// last chunk *after* the session left the roster; without this guard writeTo →
// getPooled would recreate ("resurrect") a terminal that is never attached or
// disposed again. Session ids are UUIDs (never reused), so this set is safe.
const tombstones = new Set<string>()

const THEME = {
  background: '#0b0d12',
  foreground: '#d7dce5',
  cursor: '#7aa2f7',
  cursorAccent: '#0b0d12',
  selectionBackground: '#2b3350',
  black: '#0b0d12',
  red: '#f0464a',
  green: '#43b581',
  yellow: '#faa61a',
  blue: '#7aa2f7',
  magenta: '#b892ff',
  cyan: '#56cfe1',
  white: '#d7dce5',
  brightBlack: '#4b515e'
}

export function getPooled(id: string): Pooled {
  let p = pool.get(id)
  if (!p) {
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    p = { term, fit, opened: false }
    pool.set(id, p)
  }
  return p
}

export function writeTo(id: string, data: string): void {
  if (tombstones.has(id)) return
  // Create-on-demand so output for a not-yet-viewed session is buffered in the
  // terminal (preserving scrollback) rather than dropped.
  getPooled(id).term.write(data)
}

/** Focus a session's terminal (e.g. after inserting a skill invocation). */
export function focusTerminal(id: string): void {
  pool.get(id)?.term.focus()
}

export function disposePooled(id: string): void {
  const p = pool.get(id)
  if (p) {
    try {
      p.term.dispose()
    } catch {
      /* already disposed */
    }
    pool.delete(id)
  }
  tombstones.add(id)
}
