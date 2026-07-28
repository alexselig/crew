// A renderer-side pool of terminal engines — one per session, kept alive for the
// whole session lifetime so scrollback and PTY state survive tab switches. The
// visible <CrewTerminal> imperatively (re)attaches the engine's DOM element;
// output is written here regardless of whether the session is currently shown.
//
// Beyond rendering, the pool feeds the same PTY stream through the pure OSC
// parser + block tracker (shared/), so every session accrues a semantic command
// history (getBlocks) and navigable landmarks — the payoff of owning the
// terminal layer. Parsing here (not in the engine) keeps blocks engine-agnostic.

import { createXtermEngine } from './xterm-engine'
import type { Disposable, EngineMarker, LinkProvider } from './engine'
import { OscParser, type OscEvent } from '../../shared/osc'
import { BlockTracker, type Block } from '../../shared/blocks'
import { findAssetPaths } from '../../shared/assets'
import { previewToken } from '../preview-bus'

export interface Pooled {
  engine: ReturnType<typeof createXtermEngine>
  parser: OscParser
  blocks: BlockTracker
  linkSub: Disposable
  /** Landmark rows for jump-to-prompt: OSC 133 prompt starts + Enter submits. */
  marks: EngineMarker[]
}

const pool = new Map<string, Pooled>()
// Ids of sessions whose engines have been disposed. A killed PTY can emit one
// last chunk *after* the session left the roster; without this guard writeTo →
// getPooled would recreate ("resurrect") a terminal that is never attached or
// disposed again. Session ids are UUIDs (never reused), so this set is safe.
const tombstones = new Set<string>()

// Cap navigable landmarks per session; xterm also auto-disposes markers when
// their row leaves scrollback, so this only bounds the array itself.
const MAX_MARKS = 500

// Prompt-landmark colors: each time you submit input, markPrompt() tints that
// row light-yellow with black text (a decoration overlay — it never injects
// bytes into the PTY stream) and drops a yellow tick in the overview ruler.
const PROMPT_BG = '#FFF9C4'
const PROMPT_FG = '#000000'
const PROMPT_RULER = '#FFCC00'
// Exit-code ruler ticks for completed command blocks (needs OSC 133;D marks).
const OK_RULER = '#43b581'
const ERR_RULER = '#e5484d'

export function getPooled(id: string): Pooled {
  let p = pool.get(id)
  if (!p) {
    const engine = createXtermEngine()
    engine.setLinkActivator((uri) => void window.crew.openExternal(uri))
    // Make previewable file paths in output clickable — clicking resolves the
    // token against the session cwd and opens it in the Assets panel.
    const provider: LinkProvider = {
      provide: (lineText) =>
        findAssetPaths(lineText).map((m) => ({ start: m.start, end: m.end, text: m.text })),
      activate: (text) => void previewToken(id, text)
    }
    const linkSub = engine.registerLinkProvider(provider)
    p = { engine, parser: new OscParser(), blocks: new BlockTracker(), linkSub, marks: [] }
    pool.set(id, p)
  }
  return p
}

export function writeTo(id: string, data: string): void {
  if (tombstones.has(id)) return
  // Create-on-demand so output for a not-yet-viewed session is buffered in the
  // engine (preserving scrollback) rather than dropped.
  const p = getPooled(id)
  p.engine.write(data)
  const now = Date.now()
  for (const ev of p.parser.push(data)) {
    p.blocks.apply(ev, now)
    onBoundary(p, ev)
  }
}

/** Record navigation landmarks + exit-code ruler ticks from semantic marks.
 *  Only meaningful once the engine is mounted (markers need an open terminal). */
function onBoundary(p: Pooled, ev: OscEvent): void {
  if (!p.engine.mounted) return
  if (ev.kind === 'prompt-start') {
    const m = p.engine.addMarker()
    if (m) pushMark(p, m)
  } else if (ev.kind === 'command-end') {
    const m = p.engine.addMarker()
    if (m) p.engine.decorate(m, { ruler: ev.exitCode ? ERR_RULER : OK_RULER })
  }
}

function pushMark(p: Pooled, m: EngineMarker): void {
  p.marks.push(m)
  if (p.marks.length > MAX_MARKS) p.marks.splice(0, p.marks.length - MAX_MARKS)
}

/** Focus a session's terminal (e.g. after inserting a skill invocation). */
export function focusTerminal(id: string): void {
  pool.get(id)?.engine.focus()
}

/** Semantic command blocks accrued for a session (oldest first). */
export function getBlocks(id: string): Block[] {
  return pool.get(id)?.blocks.list() ?? []
}

/**
 * Highlight the row where the user just submitted input, as a scannable
 * landmark, and record it as a jump target. Called on every submit (see
 * CrewTerminal's onInput). Recolors the cursor row (light-yellow bg + black
 * text) and adds an overview-ruler tick, without writing anything to the PTY —
 * so the agent's own TUI is untouched.
 */
export function markPrompt(id: string): void {
  const p = pool.get(id)
  if (!p || !p.engine.mounted) return
  const m = p.engine.addMarker()
  if (!m) return
  p.engine.decorate(m, { background: PROMPT_BG, foreground: PROMPT_FG, ruler: PROMPT_RULER })
  pushMark(p, m)
}

/** Scroll to the previous/next landmark relative to the current viewport.
 *  Returns true if it moved. Used by jump-to-prompt keybindings (M4). */
export function jumpToPrompt(id: string, dir: 'prev' | 'next'): boolean {
  const p = pool.get(id)
  if (!p) return false
  const lines = p.marks
    .filter((m) => !m.disposed && m.line >= 0)
    .map((m) => m.line)
    .sort((a, b) => a - b)
  if (lines.length === 0) return false
  const top = p.engine.viewportTop
  const target =
    dir === 'next' ? lines.find((l) => l > top) : [...lines].reverse().find((l) => l < top)
  if (target == null) return false
  p.engine.scrollToLine(target)
  return true
}

/** Copy the current selection to the clipboard; returns the copied text. */
export async function copySelection(id: string): Promise<string> {
  const sel = pool.get(id)?.engine.getSelection() ?? ''
  if (sel) await navigator.clipboard.writeText(sel)
  return sel
}

export function disposePooled(id: string): void {
  const p = pool.get(id)
  if (p) {
    try {
      p.linkSub.dispose()
      p.engine.dispose()
    } catch {
      /* already disposed */
    }
    pool.delete(id)
  }
  tombstones.add(id)
}
