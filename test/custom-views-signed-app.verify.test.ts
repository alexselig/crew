import { describe, expect, it } from 'vitest'
import {
  exactRelaunchStateMatches,
  extractMainErrors
} from './e2e/custom-views-signed-app.verify.mjs'

describe('custom-views signed-app verifier helpers', () => {
  it('filters main-process errors from raw stderr lines', () => {
    expect(
      extractMainErrors([
        'warn: harmless native warning',
        'Error: renderer crashed',
        'exception while syncing',
        'THROW: bad state',
        'info: still fine'
      ])
    ).toEqual(['Error: renderer crashed', 'exception while syncing', 'THROW: bad state'])
  })

  it('requires both the checked custom view and exact restored order', () => {
    const expected = ['b', 'a', 'c']

    expect(exactRelaunchStateMatches('true', expected, expected)).toBe(true)
    expect(exactRelaunchStateMatches('false', expected, expected)).toBe(false)
    expect(exactRelaunchStateMatches('true', ['a', 'b', 'c'], expected)).toBe(false)
  })
})
