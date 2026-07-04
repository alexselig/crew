// A renderer-side pool of xterm terminals — one per session, kept alive for the
// whole session lifetime so scrollback and PTY state survive tab switches. The
// visible <TerminalView> imperatively (re)attaches the terminal's DOM element;
// output is written here regardless of whether the session is currently shown.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { findAssetPaths } from '../shared/assets'
import { previewToken } from './preview-bus'

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
  background: '#0A0A0B',
  foreground: '#F2F1EA',
  cursor: '#2B4CF2',
  cursorAccent: '#0A0A0B',
  selectionBackground: 'rgba(43,76,242,0.35)',
  black: '#0A0A0B',
  red: '#e5484d',
  green: '#43b581',
  yellow: '#faa61a',
  blue: '#5F79FF',
  magenta: '#b892ff',
  cyan: '#56cfe1',
  white: '#F2F1EA',
  brightBlack: '#6b6a64'
}

export function getPooled(id: string): Pooled {
  let p = pool.get(id)
  if (!p) {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Make previewable file paths in output clickable — clicking resolves the
    // token against the session cwd and opens it in the Assets panel.
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const links = findAssetPaths(line.translateToString(true)).map((m) => ({
          // xterm ranges are 1-based with an inclusive end column.
          range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
          text: m.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (_e: MouseEvent, text: string) => void previewToken(id, text)
        }))
        cb(links.length ? links : undefined)
      }
    })
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
