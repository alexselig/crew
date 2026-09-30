import { describe, expect, it } from 'vitest'
import {
  defaultLaneAgent,
  getCopilotLaunchArgs,
  getCopilotModelSelection
} from '../src/renderer/new-session-model'
import type { CopilotModelCatalog } from '../src/shared/copilot-models'

const failed: CopilotModelCatalog = {
  models: [],
  source: 'cli',
  error: 'CLI unavailable'
}

const empty: CopilotModelCatalog = {
  models: [],
  source: 'cli'
}

const available: CopilotModelCatalog = {
  models: ['auto', 'claude-sonnet-5'],
  source: 'cli'
}

describe('optional Copilot model selection', () => {
  it.each([
    ['loading', null],
    ['failed', failed],
    ['empty', empty]
  ])('hides model selection and accepts the CLI default while %s', (_name, catalog) => {
    expect(getCopilotModelSelection(catalog, 'gpt-6-astra')).toEqual({
      visible: false,
      valid: true
    })
    expect(getCopilotLaunchArgs(['--banner'], catalog, 'gpt-6-astra')).toEqual(['--banner'])
  })

  it('shows a successful catalog and rejects an unavailable explicit selection', () => {
    expect(getCopilotModelSelection(available, 'gpt-6-astra')).toEqual({
      visible: true,
      valid: false
    })
  })

  it('adds a listed explicit model without mutating preset arguments', () => {
    const presetArgs = ['--banner', '--model=old']
    expect(getCopilotModelSelection(available, 'auto')).toEqual({
      visible: true,
      valid: true
    })
    expect(getCopilotLaunchArgs(presetArgs, available, 'auto')).toEqual([
      '--banner',
      '--model',
      'auto'
    ])
    expect(presetArgs).toEqual(['--banner', '--model=old'])
  })
})

describe('defaultLaneAgent', () => {
  // A new roster row's picker shows DEFAULT_COPILOT_MODEL the instant
  // copilot-cli is chosen, even before a catalog has loaded — so the stored
  // agent must carry that same model, or the row looks valid while
  // validateRoster still rejects it for a missing model.
  it('defaults a Copilot preset row to DEFAULT_COPILOT_MODEL, matching what the picker displays', () => {
    expect(defaultLaneAgent('copilot-cli')).toEqual({ presetId: 'copilot-cli', model: 'gpt-6-astra' })
  })

  it('leaves non-Copilot presets modelless, since their picker offers none', () => {
    expect(defaultLaneAgent('shell')).toEqual({ presetId: 'shell', model: null })
    expect(defaultLaneAgent('claude-code')).toEqual({ presetId: 'claude-code', model: null })
  })
})
