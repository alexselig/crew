import { afterEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execute }))

import { createModelCatalog } from '../src/main/copilot-models'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const completion = "--model)\nCOMPREPLY=( $(compgen -W 'auto gpt-6-astra' -- \"$cur\") )\n;;"

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  execute.mockReset()
})

describe('model completion process invocation', () => {
  it('uses the Windows command interpreter for npm .cmd shims with a fixed command', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe')
    execute.mockImplementation((_file, _args, _options, done) => { done(null, completion) })
    const result = await createModelCatalog()()
    expect(result.models).toEqual(['auto', 'gpt-6-astra'])
    expect(execute.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', 'copilot completion bash']]
    ])
    expect(execute.mock.calls[0][2].timeout).toBe(10_000)
    expect(execute.mock.calls[0][2].maxBuffer).toBe(1024 * 1024)
  })

  it('keeps Unix discovery shell-free', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    execute.mockImplementation((_file, _args, _options, done) => { done(null, completion) })
    await createModelCatalog()()
    expect(execute.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['copilot', ['completion', 'bash']]
    ])
    expect(execute.mock.calls[0][2].shell).not.toBe(true)
  })
})
