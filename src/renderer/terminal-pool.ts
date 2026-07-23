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

// Prompt-landmark colors: each time you submit input, markPrompt() tints that
// row light-yellow with black text (an xterm decoration — an overlay layer, so
// it never injects bytes into the agent's PTY stream) and drops a yellow tick
// in the overview ruler. This makes your own prompts easy to spot and scroll to
// in a wall of agent output. #RRGGBB only — xterm decorations reject alpha.
const PROMPT_BG = '#FFF9C4'
const PROMPT_FG = '#000000'
const PROMPT_RULER = '#FFCC00'

export function getPooled(id: string): Pooled {
  let p = pool.get(id)
  if (!p) {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      // Reserve a gutter so prompt landmarks (see markPrompt) show as ticks in
      // the scrollbar, letting you scan a whole session for your own prompts.
      overviewRulerWidth: 14,
      theme: THEME,
      // OSC 8 hyperlinks (emitted by many CLI agents) open in the user's default
      // browser rather than letting the default handler spawn an in-app window.
      linkHandler: {
        activate: (_e: MouseEvent, uri: string) => {
          void window.crew.openExternal(uri)
        }
      }
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

/**
 * Highlight the row where the user just submitted input, as a scannable
 * landmark. Called on every submit (see TerminalView's onData). Uses an xterm
 * decoration anchored to a marker at the current cursor line: it recolors those
 * cells (light-yellow bg + black text) and adds an overview-ruler tick, without
 * writing anything to the PTY — so the agent's own TUI rendering is untouched.
 * The marker (and its decoration) auto-dispose when the line leaves scrollback.
 */
export function markPrompt(id: string): void {
  const p = pool.get(id)
  if (!p || !p.opened) return
  const { term } = p
  const marker = term.registerMarker(0)
  if (!marker) return
  term.registerDecoration({
    marker,
    x: 0,
    width: term.cols,
    backgroundColor: PROMPT_BG,
    foregroundColor: PROMPT_FG,
    layer: 'bottom',
    overviewRulerOptions: { color: PROMPT_RULER, position: 'full' }
  })
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
