// A renderer-side pool of xterm terminals. One per session while the session is
// in active rotation, so scrollback and PTY state survive tab switches. The
// visible <TerminalView> imperatively (re)attaches the terminal's DOM element;
// output is written here regardless of whether the session is currently shown.
//
// The pool is BOUNDED (MAX_LIVE_TERMINALS). A large roster of background agents
// streams output forever — spinners, progress bars, TUI repaints — so an
// unbounded pool kept every session's emulator parsing and buffering for panes
// nobody was watching, until the renderer exhausted its memory and Blink aborted
// ("Oilpan: Large allocation ... out of memory"). A renderer that keeps dying and
// reloading is what the user sees as flicker. Past the cap a session keeps only a
// bounded tail of raw output, replayed into a fresh terminal when it is reopened.
// See terminal/lru.ts for the retirement policy.

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { findAssetPaths } from '../shared/assets'
import { previewToken } from './preview-bus'
import { selectEvictions } from './terminal/lru'

export interface Pooled {
  term: Terminal
  fit: FitAddon
  opened: boolean
  /** When a human last had this terminal on screen — drives retirement. Set by
   *  touch() on mount, never by output (see terminal/lru.ts for why). */
  lastUsed: number
  /** Recent raw output, replayed into a rebuilt terminal so a retired session
   *  reopens with context rather than a blank screen. Chunks + a running length,
   *  not one string: re-slicing a 64 KB string on every PTY chunk, for every
   *  session, is itself a CPU sink. */
  tailParts: string[]
  tailLen: number
}

const pool = new Map<string, Pooled>()
// Raw output tails for sessions whose terminal has been retired. The session is
// alive and still producing output — it just has no emulator until reopened.
const dormant = new Map<string, { tailParts: string[]; tailLen: number; lastUsed: number }>()
// Ids of sessions whose terminals have been disposed. A killed PTY can emit one
// last chunk *after* the session left the roster; without this guard writeTo →
// getPooled would recreate ("resurrect") a terminal that is never attached or
// disposed again. Session ids are UUIDs (never reused), so this set is safe.
const tombstones = new Set<string>()

/** How many terminal emulators may exist at once. Well above what any grid
 *  layout shows, so ordinary use never retires anything. */
export const MAX_LIVE_TERMINALS = 12

/** Raw output replayed into a rebuilt terminal (~a few screens of context). */
export const TAIL_LIMIT = 64 * 1024

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
      // Required for registerDecoration (the prompt-row highlight in markPrompt)
      // and the overview-ruler ticks; without it every submit throws
      // "You must set the allowProposedApi option to true".
      allowProposedApi: true,
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
    p = { term, fit, opened: false, lastUsed: Date.now(), tailParts: [], tailLen: 0 }
    const d = dormant.get(id)
    if (d) {
      // Reopening a retired session: carry its tail over and replay it so the
      // terminal shows recent context instead of an empty screen.
      dormant.delete(id)
      p.tailParts = d.tailParts
      p.tailLen = d.tailLen
      if (d.tailLen > 0) term.write(d.tailParts.join(''))
    }
    pool.set(id, p)
    enforceCap()
  }
  return p
}

/** Append raw output to a bounded replay tail. */
function pushTail(t: { tailParts: string[]; tailLen: number }, data: string): void {
  t.tailParts.push(data)
  t.tailLen += data.length
  while (t.tailLen > TAIL_LIMIT && t.tailParts.length > 1) {
    t.tailLen -= t.tailParts.shift()!.length
  }
}

/** Dispose a session's emulator but keep a replay tail so reopening it is cheap
 *  and still shows recent output. */
function retire(id: string): void {
  const p = pool.get(id)
  if (!p) return
  try {
    p.term.dispose()
  } catch {
    /* already disposed */
  }
  pool.delete(id)
  dormant.set(id, { tailParts: p.tailParts, tailLen: p.tailLen, lastUsed: p.lastUsed })
}

/** Retire least-recently-viewed unmounted terminals until the pool fits the cap. */
function enforceCap(): void {
  const entries = [...pool.entries()].map(([id, p]) => ({
    id,
    lastUsed: p.lastUsed,
    // Attached to the DOM right now — `opened` alone is sticky (it only records
    // that term.open() was ever called), which would exempt every terminal the
    // user has ever visited from retirement.
    mounted: p.opened && !!p.term.element?.isConnected
  }))
  for (const id of selectEvictions(entries, MAX_LIVE_TERMINALS)) retire(id)
}

/**
 * Mark a session as just-viewed so it sorts last for retirement. Called when a
 * terminal mounts; deliberately NOT called on write, because background agents
 * stream output constantly and would otherwise all look "recently used".
 */
export function touch(id: string): void {
  const p = pool.get(id)
  if (p) p.lastUsed = Date.now()
}

export function writeTo(id: string, data: string): void {
  if (tombstones.has(id)) return
  const live = pool.get(id)
  if (live) {
    live.term.write(data)
    pushTail(live, data)
    return
  }
  let d = dormant.get(id)
  if (!d && pool.size < MAX_LIVE_TERMINALS) {
    // Room to spare: give a not-yet-viewed session a real terminal so opening it
    // is instant and its full scrollback is there.
    const p = getPooled(id)
    p.term.write(data)
    pushTail(p, data)
    return
  }
  // At the cap, output for an unviewed session accrues as a tail only. This is
  // the case that used to allocate an emulator per session and kill the renderer.
  if (!d) {
    d = { tailParts: [], tailLen: 0, lastUsed: Date.now() }
    dormant.set(id, d)
  }
  pushTail(d, data)
}

/** Renderer-agnostic buffer text for a session (empty if not pooled). */
export function bufferText(id: string): string {
  const p = pool.get(id)
  if (!p) return ''
  const buf = p.term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    lines.push(line ? line.translateToString(true) : '')
  }
  return lines.join('\n')
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
  dormant.delete(id)
  tombstones.add(id)
}

/** Live terminal count — the bounded resource. For tests and diagnostics. */
export function liveTerminalCount(): number {
  return pool.size
}

/** Sessions kept as a tail only, without an emulator. For tests/diagnostics. */
export function dormantTerminalCount(): number {
  return dormant.size
}

/** Drop all pooled state. Tests only — production disposes per session. */
export function resetPoolForTests(): void {
  for (const p of pool.values()) {
    try {
      p.term.dispose()
    } catch {
      /* ignore */
    }
  }
  pool.clear()
  dormant.clear()
  tombstones.clear()
}
