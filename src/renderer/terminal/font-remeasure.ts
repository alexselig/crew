/**
 * Forcing xterm to re-measure the cell after a webfont arrives.
 *
 * xterm measures character size exactly once per terminal, in `open()`, and
 * caches it on CharSizeService. Nothing we do afterwards re-measures it:
 *
 *   - `FitAddon.proposeDimensions()` only *reads* the cached dimensions.
 *   - `Terminal.resize(x, y)` re-measures only when the size is unchanged AND
 *     `hasValidSize` is false -- i.e. only when the first measurement failed.
 *   - `RenderService` re-measures on an intersection change (again only when
 *     `hasValidSize` is false) and on a device-pixel-ratio change.
 *
 * So a terminal opened before JetBrains Mono finishes loading measures the
 * fallback (Menlo), records a perfectly valid size, and keeps those metrics
 * for the rest of the session. Re-fitting on `document.fonts.ready` -- which
 * is what Crew did -- recomputes rows and columns from the *stale* cell, so it
 * cannot fix the clipping it was added to fix, and it leaves the pane on the
 * fallback's cell height. That matters beyond clipping: at dpr 2, JetBrains
 * Mono measures an even device cell height (40) while Menlo measures an odd
 * one (35), and only an odd height can oscillate under the DOM renderer's
 * row-dependent rounding.
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
 * Returns true when a re-measure was triggered.
 */
export function forceCharSizeRemeasure(term: FontMeasurable): boolean {
  const original = term.options.fontFamily
  if (!original) return false
  term.options.fontFamily = `${original}, monospace`
  term.options.fontFamily = original
  return true
}

/**
 * Re-measure the cell if, and only if, the pane was opened on fallback metrics.
 *
 * Call this once the webfont has loaded, before re-fitting. `openedWithFallback`
 * is the value `primaryFontAvailable` returned at `open()` time, negated: if
 * the font was already there (the common case, once it is in the font cache),
 * the cached measurement is correct and re-measuring is pure cost.
 */
export function remeasureAfterFontLoad(
  term: FontMeasurable,
  openedWithFallback: boolean
): boolean {
  if (!openedWithFallback) return false
  return forceCharSizeRemeasure(term)
}
