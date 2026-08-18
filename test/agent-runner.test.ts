import { describe, it, expect } from 'vitest'
import { AgentRunner } from '../src/main/agent-runner'
import type { Agent } from '../src/shared/types'

const agent: Agent = {
  id: 'ag_t',
  name: 'Echo',
  icon: 'spark',
  base: 'fake',
  persona: 'p',
  contextMode: 'cwd',
  writes: false,
  order: 0
}

// A fake base: `sh -c` that prints "RESULT:" + all forwarded args (the runner's
// appended -p/prompt/flags become inert positional params, not option parsing).
const resolveBase = (): { command: string; args: string[] } => ({
  command: 'sh',
  args: ['-c', 'printf "RESULT:%s" "$*"', 'x']
})

describe('AgentRunner', () => {
  it('runs headless, streams output, ends done with the result', async () => {
    const r = new AgentRunner(resolveBase)
    const updates: string[] = []
    r.on('run', (run) => updates.push(run.status))
    const run = r.run(agent, { sessionId: 's1', cwd: process.cwd(), task: 'hello', extra: '' })
    expect(run.status).toBe('running')
    await new Promise((res) => r.on('run', (u) => u.id === run.id && u.status !== 'running' && res(null)))
    const final = r.get(run.id)!
    expect(final.status).toBe('done')
    expect(final.output).toContain('RESULT:')
    expect(final.output).toContain('hello')
    expect(updates).toContain('done')
  })

  it('cancel marks a run errored', async () => {
    const slow = (): { command: string; args: string[] } => ({
      command: 'sh',
      args: ['-c', 'sleep 1000', 'x']
    })
    const r = new AgentRunner(slow)
    const run = r.run(agent, { sessionId: null, cwd: process.cwd(), task: '', extra: '' })
    r.cancel(run.id)
    await new Promise((res) => setTimeout(res, 300))
    expect(r.get(run.id)!.status).toBe('error')
  })

  it('errors when the base is unknown', () => {
    const r = new AgentRunner(() => null)
    const run = r.run(agent, { sessionId: null, cwd: process.cwd(), task: '', extra: '' })
    expect(run.status).toBe('error')
  })
})
