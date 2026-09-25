// XtermEngine: the ONLY file in Crew that imports @xterm/*. It adapts xterm.js
// (5.5) to Crew's TerminalEngine interface, adding the WebGL renderer (with a
// safe fallback) and Unicode 11 width handling for a rendering experience that
// is at least as good as — and generally crisper/faster than — the legacy
// direct-xterm terminal. All xterm-specific quirks (private render-service
// reach for cell height, decoration/marker shapes, link coordinate base) are
// contained here so the rest of the app stays engine-agnostic.

import { Terminal, type IDisposable, type IMarker } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { ImageAddon } from '@xterm/addon-image'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import type {
  Disposable,
  EngineCapabilities,
  EngineMarker,
  FitResult,
  LinkProvider,
  RowMark,
  TerminalEngine
} from './engine'
import { decideFit } from './fit-guard'

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

/** xterm's rendered cell height in CSS px (from its render service), or 0 when
 *  not yet measured. Reaches into xterm internals (as FitAddon itself does);
 *  guarded so a shape change just disables the row cap rather than throwing.
 *  Isolated here so no other file depends on xterm internals. */
function cellHeightOf(term: Terminal): number {
  const dims = (
    term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } }
    }
  )._core?._renderService?.dimensions?.css?.cell?.height
  return typeof dims === 'number' && dims > 0 ? dims : 0
}

function toDisposable(d: IDisposable): Disposable {
  return { dispose: () => d.dispose() }
}

/**
 * How many terminals may hold a live WebGL context at once.
 *
 * Chromium caps active WebGL contexts per renderer process (16 by default) and,
 * once that cap is passed, **force-loses the oldest context** to make room. The
 * terminal that owned it drops to the DOM renderer and repaints — seen as a
 * flash in a pane the user wasn't even touching.
 *
 * Pooled engines live for a session's whole lifetime, so a context taken on
 * first mount used to be held forever: the number of live contexts grew with
 * every session ever viewed, and past the cap *each* newly shown terminal
 * evicted another one. That is why the flicker got steadily worse the longer
 * Crew ran, and why restarting the app cleared it.
 *
 * So Crew keeps its own budget, comfortably under the cap (leaving headroom for
 * other GL users in the renderer) and reclaims contexts from off-screen
 * terminals instead of letting the browser choose a victim.
 */
const MAX_WEBGL_CONTEXTS = 8

/**
 * Decoded-image storage per terminal, in MB. The image addon defaults to 128 MB
 * each; across a pool of terminals that reserves hundreds of megabytes of
 * renderer memory for inline pictures that most agent sessions never emit.
 * A few MB still comfortably holds the plots and screenshots agents do produce.
 */
const IMAGE_STORAGE_MB = 8


/** Engines currently holding a WebGL context, in acquisition order. */
const accelerated = new Set<XtermEngine>()

/**
 * Free one context by taking it back from a terminal that isn't on screen.
 * Off-screen terminals aren't painting, so reclaiming theirs is invisible; they
 * transparently re-acquire (or fall back to the DOM renderer) when shown again.
 * Returns false when every context belongs to a visible terminal.
 */
function reclaimWebglSlot(): boolean {
  for (const e of accelerated) {
    if (!e.mounted) {
      e.releaseWebgl()
      return true
    }
  }
  return false
}

/** Test seam: how many terminals currently hold a WebGL context. */
export function _webglContextCount(): number {
  return accelerated.size
}

/** Test seam: release every live WebGL context. */
export function _resetWebglBudget(): void {
  for (const e of [...accelerated]) e.releaseWebgl()
}

/** Test seam: the ceiling enforced on live WebGL contexts. */
export const _MAX_WEBGL_CONTEXTS = MAX_WEBGL_CONTEXTS

// Expose the live context count for e2e/inspection, as facade.ts does for
// terminal text. Harmless in production (a pure read of a Set's size).
;(
  globalThis as { __crewWebglContexts?: () => number; __crewWebglBudget?: number }
).__crewWebglContexts = _webglContextCount
;(globalThis as { __crewWebglBudget?: number }).__crewWebglBudget = MAX_WEBGL_CONTEXTS

/** Wraps an xterm IMarker as an engine-agnostic EngineMarker while retaining the
 *  underlying marker so decorate() can anchor to it. */
class XtermMarker implements EngineMarker {
  constructor(readonly raw: IMarker) {}
  get line(): number {
    return this.raw.line
  }
  get disposed(): boolean {
    return this.raw.line < 0
  }
  dispose(): void {
    this.raw.dispose()
  }
}

export class XtermEngine implements TerminalEngine {
  private readonly term: Terminal
  private readonly fitAddon = new FitAddon()
  private opened = false
  private webgl: WebglAddon | null = null
  private serializer: SerializeAddon | null = null
  private webglCanvas: HTMLCanvasElement | null = null
  private linkActivator: (uri: string) => void = () => {}
  readonly capabilities: EngineCapabilities = { webgl: false, images: false }

  constructor() {
    this.term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 8000,
      overviewRulerWidth: 14,
      // Enables the (stable-but-flagged) decoration + unicode-provider APIs.
      allowProposedApi: true,
      theme: THEME,
      // OSC 8 hyperlinks: route through Crew's activator (opens externally)
      // instead of letting the default handler spawn an in-app window.
      linkHandler: {
        activate: (_e: MouseEvent, uri: string) => this.linkActivator(uri)
      }
    })
    this.term.loadAddon(this.fitAddon)
    // Unicode 11 width tables: correct emoji / wide-glyph widths (an upgrade
    // over the legacy terminal, which uses xterm's default v6 tables).
    try {
      this.term.loadAddon(new Unicode11Addon())
      this.term.unicode.activeVersion = '11'
    } catch {
      /* non-fatal: fall back to default width tables */
    }
  }

  mount(host: HTMLElement): void {
    if (!this.opened) {
      this.term.open(host)
      this.opened = true
      // Inline images (Sixel + iTerm2 OSC 1337): lets agents render plots, diffs,
      // and screenshots directly in the terminal. Pure-JS decode; gated so any
      // failure never blocks the terminal.
      //
      // storageLimit is explicit and small: the addon defaults to 128 MB of
      // decoded bitmaps PER TERMINAL, which across a pool of terminals is
      // hundreds of megabytes of renderer memory reserved for pictures almost
      // no session ever emits.
      try {
        this.term.loadAddon(new ImageAddon({ storageLimit: IMAGE_STORAGE_MB }))
        this.capabilities.images = true
      } catch {
        this.capabilities.images = false
      }
    } else if (this.term.element) {
      host.appendChild(this.term.element)
    }
    // Take a WebGL context only while this terminal is actually on screen, and
    // only within Crew's budget (see MAX_WEBGL_CONTEXTS). Attached AFTER open()
    // — the addon needs a rendered element.
    this.acquireWebgl()
  }

  /**
   * Attach the WebGL renderer if a context is available within budget. Silently
   * stays on the DOM renderer when every context is spoken for by a visible
   * terminal — correct, because grabbing one anyway would make Chromium
   * force-lose a context another visible pane is drawing with (the flicker).
   */
  private acquireWebgl(): void {
    if (this.webgl || !this.opened) return
    if (accelerated.size >= MAX_WEBGL_CONTEXTS && !reclaimWebglSlot()) {
      this.capabilities.webgl = false
      return
    }
    try {
      const webgl = new WebglAddon()
      // The GPU can still drop a context on its own (OOM / system suspend);
      // release ours so the terminal falls back to the DOM renderer and the
      // slot returns to the budget rather than leaking.
      webgl.onContextLoss(() => this.releaseWebgl())
      const before = new Set(this.canvases())
      this.term.loadAddon(webgl)
      // Remember the canvas the addon just created so releaseWebgl can hand the
      // GL context back immediately (see there).
      this.webglCanvas = this.canvases().find((c) => !before.has(c)) ?? null
      this.webgl = webgl
      accelerated.add(this)
      this.capabilities.webgl = true
    } catch {
      this.capabilities.webgl = false
    }
  }

  /** Canvases currently inside this terminal's element (the WebGL renderer adds
   *  one; the DOM renderer adds none). */
  private canvases(): HTMLCanvasElement[] {
    const el = this.term.element
    return el ? Array.from(el.querySelectorAll('canvas')) : []
  }

  /** Give up this terminal's WebGL context (falls back to the DOM renderer). */
  releaseWebgl(): void {
    const webgl = this.webgl
    const canvas = this.webglCanvas
    this.webgl = null
    this.webglCanvas = null
    accelerated.delete(this)
    this.capabilities.webgl = false
    if (!webgl) return
    try {
      webgl.dispose()
    } catch {
      /* already disposed (e.g. by context loss) */
    }
    // Disposing the addon drops the canvas, but the GL context itself is only
    // reclaimed when the browser gets round to collecting it. Chromium counts
    // those not-yet-collected contexts against its 16-context cap, so a burst of
    // mounts (opening grid view over a big roster) could still overshoot and
    // make it evict someone — the very flash we're removing. WEBGL_lose_context
    // hands the context back synchronously, so our budget is the real ceiling.
    if (!canvas) return
    try {
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
        | WebGLRenderingContext
        | WebGL2RenderingContext
        | null
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      /* context already gone */
    }
  }

  unmount(host: HTMLElement): void {
    const el = this.term.element
    if (el && el.parentElement === host) host.removeChild(el)
    // The context is NOT dropped here: tab-switching back is instant if we keep
    // it, and an off-screen terminal isn't painting. It simply becomes the first
    // thing reclaimWebglSlot() takes when another terminal needs a context.
  }

  dispose(): void {
    this.releaseWebgl()
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }

  get mounted(): boolean {
    return this.opened && !!this.term.element?.isConnected
  }

  write(data: string): void {
    this.term.write(data)
  }

  /**
   * Throw away everything on screen and in scrollback.
   *
   * Used by the repair action: output an agent drew at the wrong width is
   * already wrapped and fragmented in the buffer, and no later redraw rewrites
   * history. Only the visible record is lost -- the agent's own conversation
   * lives in its transcript, not here.
   */
  clear(): void {
    this.term.reset()
  }

  onInput(cb: (data: string) => void): Disposable {
    return toDisposable(this.term.onData(cb))
  }

  onFocus(cb: () => void): Disposable {
    // xterm exposes a hidden textarea; bind focus there so callers can restore
    // focus after a DOM re-parent blurs it.
    const ta = this.term.textarea
    if (!ta) return { dispose: () => {} }
    ta.addEventListener('focus', cb)
    return { dispose: () => ta.removeEventListener('focus', cb) }
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  /**
   * Fit the terminal to its mount, or return null and change nothing.
   *
   * Never calls FitAddon.fit(), because that applies its own proposal before
   * anyone can inspect it -- and a proposal taken from a collapsed mount is a
   * plausible-looking 2 columns or 1 row rather than an obvious error. See
   * fit-guard.ts for what that did to live sessions.
   *
   * Iterates because one pass does not converge: FitAddon subtracts the
   * viewport scrollbar width, whose existence depends on the size being
   * proposed, so a pane that has just regained its size can settle wider than
   * the box that shows it. Measured at 129 columns in a container that fits
   * 125. Two passes is enough to reach a fixed point; the third is a stop.
   */
  fit(contentHeightPx: number): FitResult | null {
    const host = this.term.element?.parentElement ?? null
    const box = host
      ? { connected: host.isConnected, clientWidth: host.clientWidth, clientHeight: host.clientHeight }
      : null

    let applied: FitResult | null = null
    for (let pass = 0; pass < 3; pass++) {
      const next = decideFit({
        proposed: this.fitAddon.proposeDimensions(),
        host: box,
        contentHeightPx,
        cellHeightPx: cellHeightOf(this.term)
      })
      if (!next) return null
      applied = next
      if (this.term.cols === next.cols && this.term.rows === next.rows) break
      this.term.resize(next.cols, next.rows)
    }
    return applied
  }

  focus(): void {
    this.term.focus()
  }

  attachKeyHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.term.attachCustomKeyEventHandler(handler)
  }

  get altActive(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }

  get cursorAtBottom(): boolean {
    return this.term.buffer.active.cursorY >= this.term.rows - 1
  }

  addMarker(): EngineMarker | null {
    if (!this.opened) return null
    const raw = this.term.registerMarker(0)
    return raw ? new XtermMarker(raw) : null
  }

  decorate(marker: EngineMarker, mark: RowMark): Disposable {
    if (!(marker instanceof XtermMarker) || marker.disposed) return { dispose: () => {} }
    const dec = this.term.registerDecoration({
      marker: marker.raw,
      x: 0,
      width: this.term.cols,
      backgroundColor: mark.background,
      foregroundColor: mark.foreground,
      layer: 'bottom',
      overviewRulerOptions: mark.ruler ? { color: mark.ruler, position: 'full' } : undefined
    })
    if (dec) {
      const accent = mark.accent
      dec.onRender((el) => {
        // Decorations are purely visual — they must NEVER intercept clicks, text
        // selection, or wheel-scroll. xterm gives decoration rows pointer-events:
        // auto at a z-index above the text and as a sibling of the scroll
        // viewport, so without this a highlighted row becomes unclickable AND
        // eats wheel-scroll over it. Reapplied on every render (xterm re-renders
        // decorations on scroll); the left accent bar adds no layout shift.
        el.style.pointerEvents = 'none'
        if (accent) el.style.boxShadow = `inset 3px 0 0 0 ${accent}`
      })
    }
    return { dispose: () => dec?.dispose() }
  }

  scrollToLine(line: number): void {
    this.term.scrollToLine(line)
  }

  get viewportTop(): number {
    return this.term.buffer.active.viewportY
  }

  getSelection(): string {
    return this.term.getSelection()
  }

  /**
   * The terminal's state as an escape-sequence stream that reproduces it when
   * written to a fresh terminal — colours, attributes AND cursor position.
   *
   * This is what a retired session is rebuilt from, so it cannot be plain text.
   * A CLI agent repaints relative to the cursor (`ESC[1A`, erase, rewrite); if
   * the rebuild leaves the cursor somewhere else, that repaint lands on the
   * wrong row and the screen composites instead of updating.
   *
   * Returns '' if serialization fails, which the caller treats as "no snapshot"
   * rather than replaying something malformed.
   */
  serialize(scrollback?: number): string {
    try {
      if (!this.serializer) {
        this.serializer = new SerializeAddon()
        this.term.loadAddon(this.serializer)
      }
      return this.serializer.serialize(
        typeof scrollback === 'number' ? { scrollback } : undefined
      )
    } catch {
      return ''
    }
  }

  getVisibleText(): string {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      lines.push(line ? line.translateToString(true) : '')
    }
    return lines.join('\n')
  }

  registerLinkProvider(p: LinkProvider): Disposable {
    const sub = this.term.registerLinkProvider({
      provideLinks: (y, cb) => {
        const line = this.term.buffer.active.getLine(y - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        const links = p.provide(text, y).map((m) => ({
          // xterm ranges are 1-based with an inclusive end column.
          range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
          text: m.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (_e: MouseEvent, t: string) => p.activate(t)
        }))
        cb(links.length ? links : undefined)
      }
    })
    return toDisposable(sub)
  }

  setLinkActivator(cb: (uri: string) => void): void {
    this.linkActivator = cb
  }
}

export function createXtermEngine(): XtermEngine {
  return new XtermEngine()
}
