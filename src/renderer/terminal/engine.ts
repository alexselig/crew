// The Crew-owned terminal boundary. Everything Crew needs from a terminal
// emulator is expressed here; concrete engines (today: XtermEngine) implement
// it. No consumer imports @xterm/* directly — that dependency is sealed inside
// the adapter, so the engine can later be swapped (e.g. a WASM VT core) without
// touching the pool, the React view, or the rest of the app.

export interface Disposable {
  dispose(): void
}

export interface FitResult {
  cols: number
  rows: number
}

/** A full-width row highlight (prompt landmark / block boundary). #RRGGBB only —
 *  xterm decorations reject alpha; kept in the interface for engine-agnosticism. */
export interface RowMark {
  background?: string
  foreground?: string
  /** Overview-ruler tick color (#RRGGBB), shown in the scrollbar gutter. */
  ruler?: string
}

/** A clickable span within one rendered line. Columns are 0-based; `end` is
 *  exclusive (the adapter converts to its own coordinate system). */
export interface LinkMatch {
  start: number
  end: number
  text: string
}

export interface LinkProvider {
  /** Scan one line's plain text and return zero or more matches. */
  provide(lineText: string, y: number): LinkMatch[]
  /** Invoked when the user clicks a match. */
  activate(text: string): void
}

export interface EngineCapabilities {
  webgl: boolean
  images: boolean
}

/** A handle to a tracked buffer row. `line` follows the row as content scrolls,
 *  and is -1 once the row leaves scrollback (or the marker is disposed). */
export interface EngineMarker {
  readonly line: number
  readonly disposed: boolean
  dispose(): void
}

export interface TerminalEngine {
  // lifecycle / mounting
  mount(host: HTMLElement): void
  /** Detach the DOM element but keep terminal state (scrollback) for tab switches. */
  unmount(host: HTMLElement): void
  dispose(): void
  readonly mounted: boolean

  // io
  write(data: string): void
  onInput(cb: (data: string) => void): Disposable
  resize(cols: number, rows: number): void
  /**
   * Fit the grid to the host. `contentHeightPx` is the mount's TRUE content
   * height (border-box minus padding) so the bottom row is never clipped.
   * Returns the chosen grid size (already applied).
   */
  fit(contentHeightPx: number): FitResult
  focus(): void
  onFocus(cb: () => void): Disposable

  // landmarks / navigation (block UX)
  /** Register a marker at the current cursor row, or null if not ready. */
  addMarker(): EngineMarker | null
  /** Full-row tint + optional overview-ruler tick, anchored to a marker. */
  decorate(marker: EngineMarker, mark: RowMark): Disposable
  /** Scroll so the given absolute buffer line sits near the viewport top. */
  scrollToLine(line: number): void
  /** Absolute buffer line currently at the top of the viewport. */
  readonly viewportTop: number
  /** Currently selected text (for copy affordances). */
  getSelection(): string

  // links
  registerLinkProvider(p: LinkProvider): Disposable
  /** Handler for OSC-8 hyperlinks (opened externally, not in-app). */
  setLinkActivator(cb: (uri: string) => void): void

  readonly capabilities: EngineCapabilities
}
