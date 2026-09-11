import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_COPILOT_MODEL, withCopilotModel } from '../src/shared/copilot-models'
import { createModelCatalog, parseCopilotModels } from '../src/main/copilot-models'

const completion = `
case "$prev" in
  --model)
    COMPREPLY=( $(compgen -W 'auto gpt-6-astra claude-sonnet-5 gpt-6-astra' -- "$cur") )
    return 0
    ;;
  --context)
    COMPREPLY=( $(compgen -W 'default long_context' -- "$cur") )
    ;;
esac`

describe('Copilot model discovery', () => {
  it('reads only model choices from CLI completion without executing it', () => {
    expect(parseCopilotModels(completion)).toEqual(['auto', 'gpt-6-astra', 'claude-sonnet-5'])
  })

  it('rejects missing or executable/interpolated choice data', () => {
    expect(() => parseCopilotModels('no models here')).toThrow(/model/i)
    expect(() => parseCopilotModels(completion.replace('gpt-6-astra', '$(whoami)'))).toThrow(/model/i)
  })

  it('shares in-flight discovery and caches successful results for five minutes', async () => {
    let now = 0
    const run = vi.fn(async () => completion)
    const get = createModelCatalog(run, () => now)
    const [first, second] = await Promise.all([get(), get()])
    expect(first.models).toContain(DEFAULT_COPILOT_MODEL)
    expect(second).toEqual(first)
    await get()
    expect(run).toHaveBeenCalledTimes(1)
    now = 300_001
    await get()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reports discovery failure without inventing models and allows retry', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('CLI unavailable'))
      .mockResolvedValueOnce(completion)
    const get = createModelCatalog(run)
    expect(await get()).toEqual({ models: [], source: 'cli', error: expect.stringContaining('CLI unavailable') })
    expect((await get()).models).toContain(DEFAULT_COPILOT_MODEL)
  })
})

describe('Copilot launch model arguments', () => {
  it('replaces either model spelling without changing unrelated arguments', () => {
    expect(withCopilotModel(['--model=old', '--banner', '--model', 'other'], DEFAULT_COPILOT_MODEL))
      .toEqual(['--banner', '--model', 'gpt-6-astra'])
  })

  it('does not mutate a shared preset argument array', () => {
    const args = ['--banner']
    withCopilotModel(args, 'auto')
    expect(args).toEqual(['--banner'])
  })
})
