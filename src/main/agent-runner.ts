import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { buildAgentInvocation, makeRunId } from '../shared/agents'
import type { Agent, AgentRun } from '../shared/types'

const TIMEOUT_MS = 180000
const MAX_OUTPUT = 200000

interface Rec {
  run: AgentRun
  child: ChildProcess | null
  timer: NodeJS.Timeout | null
}

/**
 * Owns headless one-shot agent runs. Spawns the base CLI in print mode
 * (`copilot -p` / `claude -p`) via child_process, streams stdout into a
 * transient AgentRun, and emits 'run' with the full run object on every change.
 * Sibling to launcher.ts; never blocks on approval (runs are unattended), and
 * enforces a timeout + max-output cap.
 */
export class AgentRunner extends EventEmitter {
  private readonly recs = new Map<string, Rec>()

  constructor(private readonly resolveBase: (baseId: string) => { command: string; args: string[] } | null) {
    super()
  }

  get(runId: string): AgentRun | undefined {
    return this.recs.get(runId)?.run
  }

  run(agent: Agent, ctx: { sessionId: string | null; cwd: string; task: string; extra?: string }): AgentRun {
    const run: AgentRun = {
      id: makeRunId(),
      agentId: agent.id,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      task: ctx.task,
      status: 'running',
      output: '',
      startedAt: Date.now()
    }

    const fail = (msg: string): AgentRun => {
      run.status = 'error'
      run.error = msg
      run.endedAt = Date.now()
      this.recs.set(run.id, { run, child: null, timer: null })
      queueMicrotask(() => this.emit('run', { ...run }))
      return run
    }

    const base = this.resolveBase(agent.base)
    if (!base) return fail(`Unknown base agent "${agent.base}".`)

    const { args } = buildAgentInvocation(base, agent, ctx.task, ctx.extra ?? '')
    let child: ChildProcess
    try {
      child = spawn(base.command, [...base.args, ...args], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
      })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }

    const timer = setTimeout(() => this.kill(run.id, 'Timed out.'), TIMEOUT_MS)
    this.recs.set(run.id, { run, child, timer })

    const append = (buf: Buffer): void => {
      run.output = (run.output + buf.toString()).slice(-MAX_OUTPUT)
      this.emit('run', { ...run })
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (run.status !== 'running') return
      run.status = code === 0 ? 'done' : 'error'
      if (code !== 0 && !run.error) run.error = `Exited with code ${code}.`
      run.endedAt = Date.now()
      this.emit('run', { ...run })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      if (run.status !== 'running') return
      run.status = 'error'
      run.error = err instanceof Error ? err.message : String(err)
      run.endedAt = Date.now()
      this.emit('run', { ...run })
    })

    queueMicrotask(() => this.emit('run', { ...run }))
    return run
  }

  cancel(runId: string): void {
    this.kill(runId, 'Cancelled.')
  }

  private kill(runId: string, reason: string): void {
    const rec = this.recs.get(runId)
    if (!rec || rec.run.status !== 'running') return
    rec.run.status = 'error'
    rec.run.error = reason
    rec.run.endedAt = Date.now()
    if (rec.timer) clearTimeout(rec.timer)
    try {
      if (rec.child?.pid && rec.child.pid > 0) process.kill(-rec.child.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    this.emit('run', { ...rec.run })
  }

  disposeAll(): void {
    for (const id of this.recs.keys()) this.kill(id, 'Shutting down.')
  }
}
