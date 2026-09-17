import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const verifier = readFileSync(
  new URL('./e2e/context-models.verify.mjs', import.meta.url),
  'utf8'
)

describe('context model verifier source', () => {
  it('covers native-default launch while model discovery is pending, failed, and empty', () => {
    expect(verifier).toContain("modelFixture = 'pending'")
    expect(verifier).toContain("modelFixture = 'failure'")
    expect(verifier).toContain("modelFixture = 'empty'")
    expect(verifier).toContain("getByRole('combobox', { name: 'Model', exact: true }).count()")
    expect(verifier).toContain("getByRole('button', { name: 'Launch', exact: true }).isEnabled()")
    expect(verifier.match(/assert\.deepEqual\(request\.args, \[\]\)/g)).toHaveLength(3)
  })

  it('retains explicit-model submission coverage without the obsolete retry UI', () => {
    expect(verifier).toContain("selectOption('gpt-5.5')")
    expect(verifier).toContain("assert.deepEqual(request.args, ['--model', 'gpt-5.5'])")
    expect(verifier).not.toContain('Retry models')
  })
})
