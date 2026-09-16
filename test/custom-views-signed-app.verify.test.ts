import { describe, expect, it } from 'vitest'
import { extractMainErrors } from './e2e/custom-views-signed-app.verify.mjs'

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
})
