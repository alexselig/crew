import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('agent shelf keyboard access', () => {
  it('keeps the edit button focusable while visually hidden', () => {
    const css = readFileSync(resolve('src/renderer/styles.css'), 'utf8')
    const rule = css.match(/\.agent-row__edit\s*\{([^}]*)\}/)?.[1] ?? ''

    expect(rule).not.toContain('display: none')
    expect(rule).toContain('opacity: 0')
  })
})
