import { describe, it, expect } from 'vitest'
import { runSupervised, runGit, NON_INTERACTIVE_GIT_ENV } from '../src/main/supervise'
import { tmpdir } from 'node:os'

describe('runSupervised', () => {
  it('resolves with stdout and a zero exit code', async () => {
    const r = await runSupervised('sh', ['-c', 'echo hello'], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.timedOut).toBe(false)
  })

  it('captures a non-zero exit code without throwing', async () => {
    const r = await runSupervised('sh', ['-c', 'echo bad >&2; exit 3'], { cwd: tmpdir() })
    expect(r.code).toBe(3)
    expect(r.stderr.trim()).toBe('bad')
  })

  // The reason this supervisor exists. tracker.ts uses execFile with a timeout
  // but no process group, so a wedged git can leave descendants running.
  it('kills the whole process group on timeout, not just the direct child', async () => {
    const r = await runSupervised('sh', ['-c', 'sleep 30 & echo $!; wait'], {
      cwd: tmpdir(),
      timeoutMs: 300,
      graceMs: 200
    })
    expect(r.timedOut).toBe(true)
    const grandchild = Number(r.stdout.trim())
    expect(Number.isInteger(grandchild)).toBe(true)
    // Give the group kill a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(() => process.kill(grandchild, 0)).toThrow()
  })

  // A timeout that resolves while the child is still alive is a double-grant,
  // not a recovery: the next lane would meet index.lock or a moving ref.
  it('resolves only after the child has actually exited', async () => {
    const r = await runSupervised('sh', ['-c', 'trap "" TERM; sleep 30'], {
      cwd: tmpdir(),
      timeoutMs: 200,
      graceMs: 200
    })
    expect(r.timedOut).toBe(true)
    expect(() => process.kill(r.pid, 0)).toThrow()
  })

  it('reports a missing binary instead of rejecting', async () => {
    const r = await runSupervised('crew-does-not-exist', [], { cwd: tmpdir() })
    expect(r.code).toBeNull()
    expect(r.stderr).toMatch(/ENOENT|not found/i)
  })
})

describe('runGit', () => {
  it('runs git non-interactively', async () => {
    const r = await runGit(['--version'], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^git version/)
  })

  it('pins every prompt-capable git knob off', () => {
    expect(NON_INTERACTIVE_GIT_ENV.GIT_TERMINAL_PROMPT).toBe('0')
    expect(NON_INTERACTIVE_GIT_ENV.GIT_EDITOR).toBe('true')
    expect(NON_INTERACTIVE_GIT_ENV.GIT_SEQUENCE_EDITOR).toBe('true')
  })
})
