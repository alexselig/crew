import { describe, expect, it } from 'vitest'
import { shellQuote, quotePaths } from '../src/shared/shell-quote'

describe('shellQuote', () => {
  it('leaves safe paths untouched', () => {
    expect(shellQuote('/Users/alex/crew/src/main.ts')).toBe('/Users/alex/crew/src/main.ts')
    expect(shellQuote('a-b_c.d/e:f,g')).toBe('a-b_c.d/e:f,g')
  })

  it('quotes spaces and shell metacharacters', () => {
    expect(shellQuote('/tmp/my file.png')).toBe("'/tmp/my file.png'")
    expect(shellQuote('/tmp/a$b`c;d&e(f)g.png')).toBe("'/tmp/a$b`c;d&e(f)g.png'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("/tmp/it's here.png")).toBe("'/tmp/it'\\''s here.png'")
  })

  it('handles the empty string', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('joins multiple paths with spaces', () => {
    expect(quotePaths(['/a/b.png', '/c d/e.png'])).toBe("/a/b.png '/c d/e.png'")
  })
})
