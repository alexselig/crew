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
    }
  }
  return { options, writes, changes }
}

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
})

describe('remeasureAfterFontLoad', () => {
  it('re-measures a pane that opened on fallback metrics', () => {
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, true)).toBe(true)
    expect(term.changes).toHaveLength(2)
  })

  it('skips a pane whose font was already loaded when it opened', () => {
    const term = fakeTerm()
    expect(remeasureAfterFontLoad(term, false)).toBe(false)
    expect(term.writes).toEqual([])
  })
})
