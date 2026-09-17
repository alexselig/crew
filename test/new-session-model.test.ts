import { describe, expect, it } from 'vitest'
import {
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
