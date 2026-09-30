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
  //
  // Deliberately built with node rather than `sh -c 'sleep 30 & echo $!; wait'`.
  // That shape asserted the right thing on POSIX and nothing at all on Windows:
  // the only `sh` there is MSYS2's, whose `$!` is an MSYS pid from a pid space
  // that is NOT the Windows one, so `process.kill(grandchild, 0)` was probing
  // an unrelated number. node exists on both platforms, reports a real OS pid,
  // and spawns a real grandchild — so the assertion below now means the same
  // thing everywhere. The parent deliberately stays alive (node's equivalent of
  // `wait`) so the process tree is still intact when the kill lands.
  it('kills the whole process group on timeout, not just the direct child', async () => {
    const parent = [
      "const { spawn } = require('node:child_process')",
      // stdio inherited on purpose: the grandchild holds this supervisor's
      // stdout/stderr, which is exactly how a real orphan wedges it.
      `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] })`,
      'console.log(g.pid)',
      'setTimeout(() => {}, 30000)'
    ].join('\n')
    const r = await runSupervised(process.execPath, ['-e', parent], {
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

  // The hang this supervisor used to be capable of, isolated from the kill
  // path: the direct child exits cleanly and promptly, but a descendant it
  // left behind still holds the inherited stdout/stderr, so `close` does not
  // fire. Before PIPE_DRAIN_AFTER_EXIT_MS this promise waited on that orphan
  // — here, 30 seconds — with a publication lock held the whole time. The
  // budget below is well under that 30s and well over the ~2s drain, so it
  // distinguishes the two outcomes rather than merely being generous.
  it('settles once the child is reaped, even if a descendant still holds the pipes', async () => {
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] })`,
      'g.unref()',
      "console.log('parent-done')"
    ].join('\n')
    const started = Date.now()
    const r = await runSupervised(process.execPath, ['-e', parent], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toContain('parent-done')
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 20_000)

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
