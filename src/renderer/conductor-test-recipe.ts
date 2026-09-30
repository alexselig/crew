// Turns what the composer's (small, optional) test-recipe fields collected
// into the TestRecipe RosterDraft carries. Split out from ConductorComposer
// itself, the same way defaultLaneAgent/getCopilotModelSelection live in
// new-session-model.ts rather than inline in a component: this repo's tests
// run under environment: 'node' with no DOM, so a renderer decision like
// this one is only testable in isolation when it is a plain exported
// function rather than something buried inside JSX.

import type { TestRecipe } from '../shared/conductor'

export interface TestRecipeFormInput {
  command: string
  /** Whitespace-separated, matching how a shell command line is typed. */
  args: string
  cwd: string
  timeoutMs: string
}

export const EMPTY_TEST_RECIPE_INPUT: TestRecipeFormInput = {
  command: '',
  args: '',
  cwd: '',
  timeoutMs: ''
}

/** Long enough for a real test suite, short enough that a hung test doesn't
 *  block publishing indefinitely. Used only when the form's timeout field
 *  is left blank; typing a value always overrides it. */
export const DEFAULT_TEST_TIMEOUT_MS = 300_000

/** An empty command means "no recipe" — not "a recipe with an empty
 *  command" — because TestRecipe.command is required and a blank one could
 *  never run. cwd/timeoutMs are required by TestRecipe too, but the form
 *  only prompts for them when the user wants to override the default, so a
 *  blank field falls back rather than producing an invalid recipe. */
export function testRecipeFromInput(input: TestRecipeFormInput): TestRecipe | null {
  const command = input.command.trim()
  if (!command) return null

  const trimmedArgs = input.args.trim()
  const args = trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/) : []
  const cwd = input.cwd.trim() || '.'
  const parsedTimeout = Number(input.timeoutMs)
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_TEST_TIMEOUT_MS

  return { command, args, cwd, timeoutMs }
}
