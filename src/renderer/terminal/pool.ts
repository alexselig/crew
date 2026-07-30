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
import { pickJumpTarget } from '../../shared/nav'
import { shouldHighlightInputOnEnter } from '../../shared/highlight'
import { findAssetPaths } from '../../shared/assets'
import { previewToken } from '../preview-bus'
import type { TranscriptBlock } from '../transcript/types'

export interface Pooled {
  engine: ReturnType<typeof createXtermEngine>
  parser: OscParser
  blocks: BlockTracker
  linkSub: Disposable
  /** Landmark rows for jump-to-prompt: OSC 133 prompt starts + Enter submits. */
  marks: EngineMarker[]
  /** True once the session emits any OSC 133 mark (shell integration active),
   *  which switches input highlighting from the coarse Enter fallback to the
   *  accurate, semantic prompt marks. */
  hasSemanticMarks: boolean
  /** Typed session scrollback as typed blocks (drives the Transcript view). */
  transcript: TranscriptBlock[]
  /** The last command line the human submitted (correlates to a tool result). */
  lastInputLine: string
  /** Monotonic id source for transcript blocks. */
  txSeq: number
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

// User-input row highlight: each time you submit input, markPrompt() clearly
// marks that row — light-yellow background, black text, a solid amber left
// accent bar, and a yellow overview-ruler tick — so your own prompts stand out
// from agent/shell output. It's a decoration overlay (never injects bytes into
// the PTY stream), so the agent's own TUI rendering is untouched.
const PROMPT_BG = '#FFF9C4'
const PROMPT_FG = '#000000'
const PROMPT_RULER = '#FFCC00'
const PROMPT_ACCENT = '#E8A317'
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
    p = {
      engine,
      parser: new OscParser(),
      blocks: new BlockTracker(),
      linkSub,
      marks: [],
      hasSemanticMarks: false,
      transcript: [],
      lastInputLine: '',
      txSeq: 0
    }
    pool.set(id, p)
  }
  return p
}

// Cap the typed transcript so a long session doesn't grow it without bound.
const MAX_TX = 400

function pushTx(p: Pooled, block: TranscriptBlock): void {
  p.transcript.push(block)
  if (p.transcript.length > MAX_TX) p.transcript.splice(0, p.transcript.length - MAX_TX)
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
    onBoundary(p, ev, now)
  }
}

/** Renderer-agnostic buffer text for a session (empty if not pooled). Reads the
 * xterm buffer, so it works under both the DOM and WebGL renderers. */
export function bufferText(id: string): string {
  return pool.get(id)?.engine.getVisibleText() ?? ''
}

/**
 * Record a command line the human just submitted (called from CrewTerminal on
 * Enter). Adds a `user` block to the typed transcript and remembers it so a
 * following OSC 133 command-end can attribute its result. No-op for blank lines.
 */
export function recordInput(id: string, line: string): void {
  const text = line.trim()
  const p = pool.get(id)
  if (!p) return
  p.lastInputLine = text
  if (!text) return
  pushTx(p, { kind: 'user', id: `u${++p.txSeq}`, text, ts: Date.now() })
}

/** The typed session scrollback for the Transcript view (a copy). */
export function getTranscript(id: string): TranscriptBlock[] {
  return pool.get(id)?.transcript.slice() ?? []
}

/** React to semantic marks: build typed transcript blocks, highlight the
 *  prompt/input row accurately, keep navigation landmarks, and paint exit-code
 *  ruler ticks. Any mark also flips hasSemanticMarks so the coarse Enter
 *  fallback stands down for this session. */
function onBoundary(p: Pooled, ev: OscEvent, now: number): void {
  if (ev.kind === 'prompt-start' || ev.kind === 'output-start' || ev.kind === 'command-end') {
    p.hasSemanticMarks = true
  }
  // Typed transcript (independent of whether the terminal is currently mounted).
  if (ev.kind === 'command-end') {
    pushTx(p, {
      kind: 'tool',
      id: `r${++p.txSeq}`,
      command: p.lastInputLine || '(command)',
      exitCode: ev.exitCode,
      durationMs: undefined,
      ts: now
    })
  }
  // Visual decorations require a mounted terminal.
  if (!p.engine.mounted) return
  if (ev.kind === 'prompt-start') {
    // The prompt line: highlight it (this is where the user's command is typed)
    // and record it as a jump target.
    highlightInputRow(p)
  } else if (ev.kind === 'command-end') {
    const m = p.engine.addMarker()
    if (m) p.engine.decorate(m, { ruler: ev.exitCode ? ERR_RULER : OK_RULER })
  }
}

/** Apply the user-input row highlight (bg + accent bar + ruler tick) at the
 *  current cursor row and record it as a jump target. */
function highlightInputRow(p: Pooled): void {
  if (!p.engine.mounted) return
  const m = p.engine.addMarker()
  if (!m) return
  p.engine.decorate(m, {
    background: PROMPT_BG,
    foreground: PROMPT_FG,
    ruler: PROMPT_RULER,
    accent: PROMPT_ACCENT
  })
  pushMark(p, m)
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
 * Coarse Enter-based fallback for the user-input row highlight, used ONLY for
 * sessions without OSC 133 shell integration (e.g. a plain REPL). Sessions with
 * shell integration get an accurate highlight from onBoundary's prompt marks, so
 * this stands down for them; it also stands down inside full-screen/redraw TUIs
 * (alternate buffer, or cursor not on the bottom input line) where "cursor row
 * at Enter" is not a stable prompt line and would land highlights on unrelated
 * repainted content. Purely a decoration overlay — never writes to the PTY.
 */
export function markPrompt(id: string): void {
  const p = pool.get(id)
  if (!p || !p.engine.mounted) return
  const allowed = shouldHighlightInputOnEnter({
    hasSemanticMarks: p.hasSemanticMarks,
    altActive: p.engine.altActive,
    cursorAtBottom: p.engine.cursorAtBottom
  })
  if (!allowed) return
  highlightInputRow(p)
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
  const target = pickJumpTarget(lines, p.engine.viewportTop, dir)
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
