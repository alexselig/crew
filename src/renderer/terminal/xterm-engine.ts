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
      // Attach WebGL AFTER open(); fall back silently to the DOM renderer on
      // failure or context loss (browsers can drop the GL context on OOM /
      // system suspend), so a terminal never goes blank.
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        this.term.loadAddon(webgl)
        this.capabilities.webgl = true
      } catch {
        this.capabilities.webgl = false
      }
      // Inline images (Sixel + iTerm2 OSC 1337): lets agents render plots, diffs,
      // and screenshots directly in the terminal. Pure-JS decode; gated so any
      // failure never blocks the terminal.
      try {
        this.term.loadAddon(new ImageAddon())
        this.capabilities.images = true
      } catch {
        this.capabilities.images = false
      }
    } else if (this.term.element) {
      host.appendChild(this.term.element)
    }
  }

  unmount(host: HTMLElement): void {
    const el = this.term.element
    if (el && el.parentElement === host) host.removeChild(el)
  }

  dispose(): void {
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

  fit(contentHeightPx: number): FitResult {
    this.fitAddon.fit()
    // FitAddon measures padding on the .xterm element, but Crew's padding lives
    // on the parent mount (border-box), so it proposes one row too many and the
    // bottom row (input prompt / footer) gets clipped. Cap rows to the mount's
    // true content height so the last row is always fully visible.
    const cellH = cellHeightOf(this.term)
    if (cellH > 0 && contentHeightPx > 0) {
      const maxRows = Math.max(1, Math.floor(contentHeightPx / cellH))
      if (this.term.rows > maxRows) this.term.resize(this.term.cols, maxRows)
    }
    return { cols: this.term.cols, rows: this.term.rows }
  }

  focus(): void {
    this.term.focus()
  }

  attachKeyHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.term.attachCustomKeyEventHandler(handler)
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
