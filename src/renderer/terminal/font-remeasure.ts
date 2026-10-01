/**
 * Forcing xterm to re-measure the cell after a webfont arrives.
 *
 * xterm measures character size in `open()` and caches it on CharSizeService.
 * It re-measures on exactly one path that a font load can reach, and that path
 * requires the grid to actually change size:
 *
 *   - `Terminal._afterResize` re-measures unconditionally, but it only runs via
 *     `BufferService.onResize`, so only when `resize(x, y)` changes cols/rows.
 *   - `Terminal.resize(x, y)` with the *same* dimensions re-measures only when
 *     `hasValidSize` is false -- i.e. only when the first measurement failed.
 *   - `RenderService` re-measures on an intersection change (again only when
 *     `hasValidSize` is false) and on a device-pixel-ratio change.
 *   - `FitAddon.proposeDimensions()` only *reads* the cached dimensions.
 *
 * `hasValidSize` is just `width > 0 && height > 0`, so a pane that measured the
 * fallback (Menlo) successfully has a perfectly valid size and none of the
 * conditional paths fire. What is left is: **no re-measure happens unless the
 * grid size changes.**
 *
 * That is exactly the case Crew's `document.fonts.ready` re-fit cannot escape.
 * It recomputes rows and columns from the *stale* cell; when the stale
 * proposal matches the size the grid already has -- the steady state, once the
 * initial fit converged -- `resize()` takes its no-op branch, nothing is
 * re-measured, and the pane keeps the fallback's cell height until something
 * else resizes it. That matters beyond clipping: at dpr 2, JetBrains Mono
 * measures an even device cell height (40) while Menlo measures an odd one
 * (35), and only an odd height can oscillate under the DOM renderer's
 * row-dependent rounding.
 *
 * The bug is therefore self-limiting -- the first window resize or density
 * change heals the pane -- but "self-limiting" means "wrong until the user
 * happens to resize something", which is not good enough for the first paint.
 *
 * The one public lever that reaches CharSizeService is the options setter:
 * it registers `onMultipleOptionChange(['fontFamily', 'fontSize'])`. xterm
 * suppresses the event when the assigned value is unchanged, so forcing a
 * re-measure means round-tripping through a different string.
 */

/** The part of a terminal this module touches. */
export interface FontMeasurable {
  options: { fontFamily?: string; fontSize?: number }
}

/** The part of `document.fonts` this module needs. */
export interface FontAvailability {
  check(font: string): boolean
}

/**
 * The first family in a CSS font stack, unquoted.
 *
 * Only the head matters: it is the webfont that may still be loading, and
 * everything after it is a locally installed fallback.
 */
export function primaryFamily(stack: string | undefined): string | null {
  if (!stack) return null
  const head = stack.split(',')[0]?.trim()
  if (!head) return null
  const unquoted = head.replace(/^['"]|['"]$/g, '').trim()
  return unquoted || null
}

/**
 * Whether the stack's primary family can be used for measurement right now.
 *
 * Returns true when we cannot tell (no FontFaceSet, unparseable stack). An
 * unnecessary skip costs nothing, whereas an unnecessary re-measure costs two
 * full renderer refreshes on every pane.
 */
export function primaryFontAvailable(
  term: FontMeasurable,
  fonts: FontAvailability | undefined
): boolean {
  if (!fonts) return true
  const family = primaryFamily(term.options.fontFamily)
  if (!family) return true
  const size = term.options.fontSize && term.options.fontSize > 0 ? term.options.fontSize : 12
  try {
    return fonts.check(`${size}px "${family}"`)
  } catch {
    // An invalid shorthand throws; treat it as "cannot tell".
    return true
  }
}

/**
 * Round-trip `fontFamily` so CharSizeService measures the cell again.
 *
 * The intermediate value appends a duplicate `monospace` to the stack. CSS
 * resolves it identically -- the first available family still wins, and the
 * stack already ended in `monospace` -- so nothing renders differently while
 * it is set. Only the change *event* matters.
 *
 * Returns true when the round trip completed and the original value is back.
 *
 * The assignment fires `_onOptionChange` *synchronously*, and its listeners run
 * real work -- `CharSizeService.measure()`, and a RenderService handler that
 * does `clear()`, `handleResize()` and `_fullRefresh()`, which with the WebGL
 * addon loaded reaches into texture-atlas teardown. If any of that throws, the
 * restore must still happen, or the terminal is stranded on the intermediate
 * stack and every later attempt appends another `, monospace` to it.
 */
export function forceCharSizeRemeasure(term: FontMeasurable): boolean {
  const original = term.options.fontFamily
  if (!original) return false
  try {
    term.options.fontFamily = `${original}, monospace`
  } finally {
    term.options.fontFamily = original
  }
  return true
}

/**
 * Re-measure the cell if, and only if, the pane was opened on fallback metrics
 * and the real font has since arrived.
 *
 * Call this once the webfont has loaded, before re-fitting. `openedWithFallback`
 * is the value `primaryFontAvailable` returned at `open()` time, negated: if
 * the font was already there (the common case, once it is in the font cache),
 * the cached measurement is correct and re-measuring is pure cost.
 *
 * The second check is not redundant. `document.fonts.ready` resolves when the
 * *pending* loads settle, which says nothing about a `font-display: swap` face
 * that has not been requested yet -- and a promise captured at mount may
 * already be fulfilled. Re-measuring there would measure the fallback a second
 * time and achieve nothing, so we report false and leave the caller's flag
 * armed for the next opportunity rather than burning the pane's one chance.
 */
export function remeasureAfterFontLoad(
  term: FontMeasurable,
  openedWithFallback: boolean,
  fonts: FontAvailability | undefined
): boolean {
  if (!openedWithFallback) return false
  if (!primaryFontAvailable(term, fonts)) return false
  return forceCharSizeRemeasure(term)
}
