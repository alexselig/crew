// A renderer-side pool of terminal engines. One per session while the session is
// in active rotation, so scrollback and PTY state survive tab switches; output is
// written here regardless of whether the session is currently shown.
//
// The pool is BOUNDED (MAX_LIVE_ENGINES). A large roster of background agents
// streams output forever — spinners, progress bars, TUI repaints — so an
// unbounded pool kept sixty-odd emulators parsing and buffering for sessions
// nobody was watching, which exhausted the renderer's memory and made Blink
// abort ("Oilpan: Large allocation ... out of memory"). Beyond the cap a session
// goes *dormant*: it keeps its OSC parse state, semantic blocks, typed
// transcript and replayable reattach context, but owns no emulator until someone
// looks at it. See lru.ts for the retirement policy.
//
// Beyond rendering, the pool feeds the same PTY stream through the pure OSC
// parser + block tracker (shared/), so every session accrues a semantic command
// history (getBlocks) and navigable landmarks — the payoff of owning the
// terminal layer. Parsing here (not in the engine) keeps blocks engine-agnostic,
// and is precisely why a dormant session loses no history.

import { createXtermEngine } from './xterm-engine'
import { selectEvictions } from './lru'
import type { Disposable, EngineMarker, LinkProvider, TerminalEngine } from './engine'
import { OscParser, type OscEvent } from '../../shared/osc'
import { BlockTracker, type Block } from '../../shared/blocks'
import { pickJumpTarget } from '../../shared/nav'
import { shouldHighlightInputOnEnter } from '../../shared/highlight'
import { findAssetPaths } from '../../shared/assets'
import { previewLines } from '../../shared/preview'
import { previewToken } from '../preview-bus'
import type { TranscriptBlock } from '../transcript/types'

/**
 * Everything Crew knows about a session's terminal that is NOT the emulator:
 * the OSC parse state, semantic blocks, the typed transcript, and replayable
 * terminal context. All of it is plain data, so it survives when the engine is
 * retired and makes a retired session cheap to bring back.
 */
export interface Semantic {
  parser: OscParser
  blocks: BlockTracker
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
  /** Recent raw output, replayed into a rebuilt engine so a retired session
   *  still opens with context instead of a blank screen. Held as chunks (with
   *  a running length) rather than one string — appending to a 64K-code-unit string on
   *  every PTY chunk, for every session, is itself a CPU sink. */
  tailParts: string[]
  tailLen: number
  /** Plain-text terminal buffer snapshot captured before an engine is retired.
   * Replayed before post-retirement tail chunks so mode switches do not drop
   * scrollback older than the bounded raw-output tail. */
  scrollbackSnapshot: string
  /** When a human last had this terminal on screen — drives retirement. Set by
   *  touch() on mount, never by output (see lru.ts for why). */
  lastUsed: number
}

export interface Pooled extends Semantic {
  engine: ReturnType<typeof createXtermEngine>
  linkSub: Disposable
  /** Landmark rows for jump-to-prompt: OSC 133 prompt starts + Enter submits. */
  marks: EngineMarker[]
}

// Live engines, capped by MAX_LIVE_ENGINES.
const pool = new Map<string, Pooled>()
// Sessions whose engine has been retired to bound memory. The session is very
// much alive — output still parses into blocks and the transcript here — it
// simply has no emulator until someone looks at it again.
const dormant = new Map<string, Semantic>()
// Ids of sessions whose engines have been disposed. A killed PTY can emit one
// last chunk *after* the session left the roster; without this guard writeTo →
// getPooled would recreate ("resurrect") a terminal that is never attached or
// disposed again. Session ids are UUIDs (never reused), so this set is safe.
const tombstones = new Set<string>()
let renderingActive = true

/**
 * How many terminal emulators may exist at once. Everything above this is
 * retired to `dormant`, which costs a session nothing user-visible beyond
 * decorations tied to the old xterm buffer. Well above the number of panes any
 * grid layout shows, so ordinary use never retires anything; it only bites on
 * the large rosters that were exhausting the renderer.
 */
export const MAX_LIVE_ENGINES = 12

/** Maximum UTF-16 code units replayed into a rebuilt engine. */
export const TAIL_LIMIT = 64 * 1024

/**
 * Scrollback lines kept in a retired session's snapshot.
 *
 * A snapshot with attributes is far denser than the plain text it replaced, and
 * one is held for every dormant session — over a hundred of them on a large
 * roster. Bounding it keeps that store smaller than the text version it
 * replaces, which matters because an unbounded renderer heap is what the pool
 * exists to prevent. The viewport is always included regardless of this cap;
 * only the history above it is trimmed.
 */
const SNAPSHOT_SCROLLBACK = 1000

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

function newSemantic(): Semantic {
  return {
    parser: new OscParser(),
    blocks: new BlockTracker(),
    hasSemanticMarks: false,
    transcript: [],
    lastInputLine: '',
    txSeq: 0,
    tailParts: [],
    tailLen: 0,
    scrollbackSnapshot: '',
    lastUsed: Date.now()
  }
}

function replayableSnapshot(text: string): string {
  return text ? text.replace(/\r?\n/g, '\r\n') : ''
}

/**
 * The exact bytes replayed into a rebuilt engine for a retired session.
 *
 * Exported so tests exercise the real thing rather than a copy of it: this is
 * the contract that decides whether a session survives retirement intact.
 *
 * It must be an escape-sequence stream, not text. A live agent keeps drawing
 * relative to the cursor after the rebuild, so a snapshot that restores only
 * the characters — losing the cursor position, colours and attributes — leaves
 * the agent repainting rows that are no longer where it left them.
 *
 * Flat text remains the fallback for engines that cannot serialize, which is
 * degraded but never worse than what it replaced.
 */
export function snapshotOf(engine: TerminalEngine): string {
  return engine.serialize(SNAPSHOT_SCROLLBACK) || replayableSnapshot(engine.getVisibleText())
}

/** Append raw output to the bounded replay tail. */
function pushTail(s: Semantic, data: string): void {
  if (!data) return
  s.tailParts.push(data)
  s.tailLen += data.length
  if (s.tailLen <= TAIL_LIMIT) return
  while (s.tailLen - s.tailParts[0].length >= TAIL_LIMIT) {
    s.tailLen -= s.tailParts.shift()!.length
  }
  const trim = s.tailLen - TAIL_LIMIT
  s.tailParts[0] = s.tailParts[0].slice(trim)
  s.tailLen -= trim
  // Trimming can bisect a surrogate pair, including one spanning PTY chunks.
  const first = s.tailParts[0].charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) {
    s.tailParts[0] = s.tailParts[0].slice(1)
    s.tailLen--
    if (!s.tailParts[0]) s.tailParts.shift()
  }
}

/**
 * Dispose a session's emulator but keep the session: its parse state, blocks,
 * transcript and replayable context move to `dormant`, so output keeps accruing
 * and reopening restores context. Markers are dropped — they anchor to rows in
 * the buffer being destroyed.
 */
function retire(id: string): void {
  const p = pool.get(id)
  if (!p) return
  const scrollbackSnapshot = snapshotOf(p.engine)
  const tailParts = scrollbackSnapshot ? [] : p.tailParts
  const tailLen = scrollbackSnapshot ? 0 : p.tailLen
  try {
    p.linkSub.dispose()
    p.engine.dispose()
  } catch {
    /* already disposed */
  }
  pool.delete(id)
  dormant.set(id, {
    parser: p.parser,
    blocks: p.blocks,
    hasSemanticMarks: p.hasSemanticMarks,
    transcript: p.transcript,
    lastInputLine: p.lastInputLine,
    txSeq: p.txSeq,
    tailParts,
    tailLen,
    scrollbackSnapshot,
    lastUsed: p.lastUsed
  })
}

/** Retire least-recently-viewed unmounted engines until the pool fits the cap. */
function enforceCap(): void {
  const entries = [...pool.entries()].map(([id, p]) => ({
    id,
    lastUsed: p.lastUsed,
    mounted: p.engine.mounted
  }))
  for (const id of selectEvictions(entries, MAX_LIVE_ENGINES)) retire(id)
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
    // Reclaim the semantics of a previously retired session, so blocks and the
    // transcript continue rather than restart.
    const sem = dormant.get(id) ?? newSemantic()
    dormant.delete(id)
    sem.lastUsed = Date.now()
    p = { ...sem, engine, linkSub, marks: [] }
    pool.set(id, p)
    // Replay recent output straight into the engine — not through writeTo,
    // which would re-parse it and duplicate blocks already recorded.
    if (p.scrollbackSnapshot) engine.write(p.scrollbackSnapshot)
    if (p.tailLen > 0) engine.write(p.tailParts.join(''))
    enforceCap()
  }
  return p
}

// Cap the typed transcript so a long session doesn't grow it without bound.
const MAX_TX = 400

function pushTx(p: Semantic, block: TranscriptBlock): void {
  p.transcript.push(block)
  if (p.transcript.length > MAX_TX) p.transcript.splice(0, p.transcript.length - MAX_TX)
}

/**
 * Feed one PTY chunk through the semantic layer: replay tail, OSC parse, block
 * tracking, and (only when an engine is live and mounted) visual decorations.
 * Runs identically for live and dormant sessions, which is what lets a retired
 * terminal keep an accurate transcript with no emulator attached.
 */
function ingest(s: Semantic, data: string, p: Pooled | null): void {
  pushTail(s, data)
  const now = Date.now()
  for (const ev of s.parser.push(data)) {
    s.blocks.apply(ev, now)
    onBoundary(s, ev, now, p)
  }
}

export function writeTo(id: string, data: string): void {
  if (tombstones.has(id)) return
  if (!renderingActive) {
    let dormantSession = dormant.get(id)
    if (!dormantSession) {
      dormantSession = newSemantic()
      dormant.set(id, dormantSession)
    }
    ingest(dormantSession, data, null)
    return
  }
  const live = pool.get(id)
  if (live) {
    live.engine.write(data)
    ingest(live, data, live)
    return
  }
  let s = dormant.get(id)
  if (!s && pool.size < MAX_LIVE_ENGINES) {
    // Room to spare: give a not-yet-viewed session a real terminal so opening
    // it is instant and its full scrollback is there.
    const p = getPooled(id)
    p.engine.write(data)
    ingest(p, data, p)
    return
  }
  // At the cap, output for an unviewed session accrues semantically only. This
  // is the case that used to allocate a 63rd emulator and kill the renderer.
  if (!s) {
    s = newSemantic()
    dormant.set(id, s)
  }
  ingest(s, data, null)
}

/** Renderer-agnostic buffer text for a session (empty if not pooled). Reads the
 * xterm buffer, so it works under both the DOM and WebGL renderers. */
export function bufferText(id: string): string {
  return pool.get(id)?.engine.getVisibleText() ?? ''
}

/**
 * Recent output as plain text lines, for a tile with no live emulator. Works for
 * live and dormant sessions alike — dormant sessions keep the same replay tail
 * the engine would have been fed — so a tile that is scrolled off-screen still
 * shows what its agent is doing.
 */
export function previewText(id: string, maxLines?: number): string[] {
  const p = pool.get(id)
  if (p) return previewLines(p.scrollbackSnapshot + p.tailParts.join(''), maxLines)
  const d = dormant.get(id)
  return d ? previewLines(d.scrollbackSnapshot + d.tailParts.join(''), maxLines) : []
}

/**
 * Record a command line the human just submitted (called from CrewTerminal on
 * Enter). Adds a `user` block to the typed transcript and remembers it so a
 * following OSC 133 command-end can attribute its result. No-op for blank lines.
 */
export function recordInput(id: string, line: string): void {
  const text = line.trim()
  const p = pool.get(id) ?? dormant.get(id)
  if (!p) return
  p.lastInputLine = text
  if (!text) return
  pushTx(p, { kind: 'user', id: `u${++p.txSeq}`, text, ts: Date.now() })
}

/** The typed session scrollback for the Transcript view (a copy). */
export function getTranscript(id: string): TranscriptBlock[] {
  return (pool.get(id) ?? dormant.get(id))?.transcript.slice() ?? []
}

/** React to semantic marks: build typed transcript blocks, highlight the
 *  prompt/input row accurately, keep navigation landmarks, and paint exit-code
 *  ruler ticks. Any mark also flips hasSemanticMarks so the coarse Enter
 *  fallback stands down for this session. Decorations need a live, mounted
 *  engine; the typed transcript does not, so a dormant session (p === null)
 *  still records everything but the visuals. */
function onBoundary(s: Semantic, ev: OscEvent, now: number, p: Pooled | null): void {
  if (ev.kind === 'prompt-start' || ev.kind === 'output-start' || ev.kind === 'command-end') {
    s.hasSemanticMarks = true
  }
  // Typed transcript (independent of whether the terminal is currently mounted).
  if (ev.kind === 'command-end') {
    pushTx(s, {
      kind: 'tool',
      id: `r${++s.txSeq}`,
      command: s.lastInputLine || '(command)',
      exitCode: ev.exitCode,
      durationMs: undefined,
      ts: now
    })
  }
  // Visual decorations require a mounted terminal.
  if (!p || !p.engine.mounted) return
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
  return (pool.get(id) ?? dormant.get(id))?.blocks.list() ?? []
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

/**
 * Discard a pane's mangled rendering so it can be redrawn clean.
 *
 * Clearing the emulator alone is not enough: a retired engine is rebuilt from
 * `scrollbackSnapshot` plus the raw tail, so wrapped and fragmented output
 * drawn at the wrong width would come straight back the next time the pane was
 * retired and reopened. Marks are row landmarks into a buffer that no longer
 * exists, so they go too.
 *
 * Blocks and the transcript are deliberately kept. They are the session's real
 * history, they are not what the width bug damaged, and dropping them would
 * turn a rendering repair into data loss.
 */
export function clearPane(id: string): void {
  const p = pool.get(id)
  if (p) {
    try {
      p.engine.clear()
    } catch {
      /* already disposed */
    }
    p.marks.length = 0
  }
  const sem: Semantic | undefined = p ?? dormant.get(id)
  if (sem) {
    sem.scrollbackSnapshot = ''
    sem.tailParts.length = 0
    sem.tailLen = 0
  }
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
  dormant.delete(id)
  tombstones.add(id)
}

/** Retire every live engine while preserving reattach context. Used when the
 * app-wide terminal engine toggle moves this pool inactive after its grace
 * period. This is not a session close, so tombstones are untouched. */
export function retireAllPooled(): void {
  for (const id of [...pool.keys()]) retire(id)
}

export function setRenderingActive(active: boolean): void {
  if (active === renderingActive) return
  renderingActive = active
  if (!active) {
    for (const id of [...pool.keys()]) retire(id)
  }
}

/** Live engine count — the bounded resource. For tests and diagnostics. */
export function liveEngineCount(): number {
  return pool.size
}

/** Sessions kept semantically but without an emulator. For tests/diagnostics. */
export function dormantCount(): number {
  return dormant.size
}

/** Drop all pooled state. Tests only — production disposes per session. */
export function resetPoolForTests(): void {
  for (const id of [...pool.keys()]) {
    try {
      pool.get(id)!.engine.dispose()
    } catch {
      /* ignore */
    }
  }
  pool.clear()
  dormant.clear()
  tombstones.clear()
  renderingActive = true
}
