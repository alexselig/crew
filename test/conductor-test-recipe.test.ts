import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TEST_TIMEOUT_MS,
  EMPTY_TEST_RECIPE_INPUT,
  testRecipeFromInput
} from '../src/renderer/conductor-test-recipe'

describe('testRecipeFromInput', () => {
  it('treats a blank command as no recipe at all', () => {
    expect(testRecipeFromInput(EMPTY_TEST_RECIPE_INPUT)).toBeNull()
    expect(testRecipeFromInput({ ...EMPTY_TEST_RECIPE_INPUT, args: 'test', cwd: '.' })).toBeNull()
  })

  it('splits args on whitespace', () => {
    const recipe = testRecipeFromInput({
      command: 'npm', args: 'run test --silent', cwd: '', timeoutMs: ''
    })
    expect(recipe?.args).toEqual(['run', 'test', '--silent'])
  })

  it('defaults cwd to "." and timeout to DEFAULT_TEST_TIMEOUT_MS when left blank', () => {
    const recipe = testRecipeFromInput({ command: 'npm test', args: '', cwd: '', timeoutMs: '' })
    expect(recipe).toEqual({
      command: 'npm test', args: [], cwd: '.', timeoutMs: DEFAULT_TEST_TIMEOUT_MS
    })
  })

  it('honours an explicit cwd and timeout', () => {
    const recipe = testRecipeFromInput({
      command: 'npm test', args: '', cwd: 'packages/app', timeoutMs: '15000'
    })
    expect(recipe).toEqual({ command: 'npm test', args: [], cwd: 'packages/app', timeoutMs: 15_000 })
  })

  it('falls back to the default timeout for a non-numeric or non-positive value', () => {
    expect(testRecipeFromInput({ command: 'npm test', args: '', cwd: '', timeoutMs: 'abc' })?.timeoutMs)
      .toBe(DEFAULT_TEST_TIMEOUT_MS)
    expect(testRecipeFromInput({ command: 'npm test', args: '', cwd: '', timeoutMs: '0' })?.timeoutMs)
      .toBe(DEFAULT_TEST_TIMEOUT_MS)
    expect(testRecipeFromInput({ command: 'npm test', args: '', cwd: '', timeoutMs: '-5' })?.timeoutMs)
      .toBe(DEFAULT_TEST_TIMEOUT_MS)
  })
})
