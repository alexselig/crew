import { describe, expect, it } from 'vitest'
import {
  forceCharSizeRemeasure,
  primaryFamily,
  primaryFontAvailable,
  remeasureAfterFontLoad
} from '../src/renderer/terminal/font-remeasure'

const STACK = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace"

/** Records every fontFamily assignment, and suppresses no-op writes as xterm does. */
function fakeTerm(...args: [fontFamily?: string | undefined, fontSize?: number]) {
  // Read through `args` rather than a default parameter, so an explicit
  // `fakeTerm(undefined)` really means "no stack" instead of falling back.
  let fontFamily = args.length > 0 ? args[0] : STACK
  const fontSize = args[1] ?? 12
  const writes: string[] = []
  const changes: string[] = []
  let explode = false
  const options = {
    fontSize,
    get fontFamily() {
      return fontFamily
    },
    set fontFamily(value: string | undefined) {
      writes.push(String(value))
      // xterm's OptionsService fires onOptionChange only on a real change.
      if (value !== fontFamily) changes.push(String(value))
      fontFamily = value
      if (explode) {
        explode = false
        throw new Error('listener exploded')
      }
    }
  }
  return {
    options,
    writes,
    changes,
    set throwOnNextChange(value: boolean) {
      explode = value
    }
  }
}

const loaded: { check(font: string): boolean } = { check: () => true }
const notLoaded: { check(font: string): boolean } = { check: () => false }

describe('primaryFamily', () => {
  it('unquotes the head of the stack', () => {
    expect(primaryFamily(STACK)).toBe('JetBrains Mono')
    expect(primaryFamily('"Fira Code", monospace')).toBe('Fira Code')
    expect(primaryFamily('monospace')).toBe('monospace')
  })

  it('returns null for an empty or missing stack', () => {
    expect(primaryFamily(undefined)).toBeNull()
    expect(primaryFamily('')).toBeNull()
    expect(primaryFamily('  ,  ')).toBeNull()
  })
})

describe('primaryFontAvailable', () => {
  it('asks the FontFaceSet about the primary family at the terminal font size', () => {
    const asked: string[] = []
    const term = fakeTerm(STACK, 14)
    primaryFontAvailable(term, { check: (f) => (asked.push(f), true) })
    expect(asked).toEqual(['14px "JetBrains Mono"'])
  })

  it('reports false when the webfont has not loaded yet', () => {
    expect(primaryFontAvailable(fakeTerm(), { check: () => false })).toBe(false)
  })

  it('assumes available when it cannot tell', () => {
    // An unnecessary skip costs nothing; an unnecessary re-measure costs two
    // renderer refreshes on every pane.
    expect(primaryFontAvailable(fakeTerm(), undefined)).toBe(true)
    expect(primaryFontAvailable(fakeTerm(undefined), { check: () => false })).toBe(true)
    expect(primaryFontAvailable(fakeTerm(), {
      check: () => {
        throw new SyntaxError('bad font shorthand')
      }
    })).toBe(true)
  })
})

describe('forceCharSizeRemeasure', () => {
  it('round-trips through a different value so the change event actually fires', () => {
    const term = fakeTerm()
    expect(forceCharSizeRemeasure(term)).toBe(true)
    expect(term.changes).toHaveLength(2)
    expect(term.changes[0]).not.toBe(STACK)
  })

  it('leaves the stack exactly as it found it', () => {
    const term = fakeTerm()
    forceCharSizeRemeasure(term)
    expect(term.options.fontFamily).toBe(STACK)
  })

  it('keeps the same family resolving first while the intermediate value is set', () => {
    const term = fakeTerm()
    forceCharSizeRemeasure(term)
    expect(primaryFamily(term.writes[0])).toBe('JetBrains Mono')
  })

  it('does nothing without a stack to round-trip', () => {
    const term = fakeTerm(undefined)
    expect(forceCharSizeRemeasure(term)).toBe(false)
    expect(term.writes).toEqual([])
  })

  it('restores the original stack even when a change listener throws', () => {
    // xterm fires onOptionChange synchronously inside the setter, and its
    // listeners do real work (CharSizeService.measure, a renderer clear and
    // full refresh, WebGL atlas teardown). If one throws and we did not
    // restore, the terminal would be stranded on the intermediate stack --
    // and every later attempt would append another `, monospace` to it.
    const term = fakeTerm()
    term.throwOnNextChange = true
    expect(() => forceCharSizeRemeasure(term)).toThrow('listener exploded')
    expect(term.options.fontFamily).toBe(STACK)

    // A second attempt must round-trip from the original, not a grown stack.
    expect(forceCharSizeRemeasure(term)).toBe(true)
    expect(term.options.fontFamily).toBe(STACK)
    expect(term.writes.filter((w) => w === `${STACK}, monospace`)).toHaveLength(2)
  })
})

describe('remeasureAfterFontLoad', () => {
  it('re-measures a pane that opened on fallback metrics', () => {
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, true, loaded)).toBe(true)
    expect(term.changes).toHaveLength(2)
  })

  it('skips a pane whose font was already loaded when it opened', () => {
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, false, loaded)).toBe(false)
    expect(term.writes).toEqual([])
  })

  it('does not burn the pane\'s one chance when the font still is not there', () => {
    // `document.fonts.ready` resolves when *pending* loads settle, which says
    // nothing about a `font-display: swap` face that was never requested --
    // and a promise captured at mount may already be fulfilled. Re-measuring
    // there would measure the fallback again and achieve nothing, so we
    // report false and let the caller keep its flag armed.
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, true, notLoaded)).toBe(false)
    expect(term.writes).toEqual([])
  })

  it('re-measures when it cannot tell whether the font is there', () => {
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, true, undefined)).toBe(true)
  })
})
