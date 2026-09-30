// A process supervisor for the conductor. Neither existing pattern in this
// codebase meets the requirement:
//   - tracker.ts uses execFile with a timeout and SIGKILL, but does NOT put
//     the child in its own process group, so a wedged git can leave
//     descendants running.
//   - agent-runner.ts does spawn detached and kills with process.kill(-pid),
//     but marks the run finished BEFORE the process exits.
// The publication lock is released only after the promise here settles, so
// "resolves only on confirmed exit" is the whole point of this file.

import { spawn } from 'node:child_process'

/** An editor or credential prompt with no TTY hangs until the timeout, which
 *  is precisely the lost-lock failure this design is built to avoid. */
export const NON_INTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  GIT_PAGER: 'cat',
  GIT_CONFIG_NOSYSTEM: '1'
} as const

export interface SuperviseOptions {
  cwd: string
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number
  env?: Record<string, string>
}

export interface SupervisedResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The child's pid, which is also its process-group id (detached: true). */
  pid: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_GRACE_MS = 3_000
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

export function runSupervised(
  command: string,
  args: string[],
  options: SuperviseOptions
): Promise<SupervisedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS

  return new Promise<SupervisedResult>((resolve) => {
    // detached: true gives the child its own process group whose pgid is its
    // pid, so process.kill(-pid) reaches every descendant it spawned.
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const pid = child.pid ?? -1
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const capture = (current: string, chunk: Buffer): string =>
      current.length >= MAX_CAPTURE_BYTES ? current : current + chunk.toString('utf8')

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = capture(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = capture(stderr, chunk)
    })

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pid <= 0) return
      try {
        process.kill(-pid, signal)
      } catch {
        // The group may already be gone, or the platform may not support it.
        try {
          child.kill(signal)
        } catch {
          /* already exited */
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      signalGroup('SIGTERM')
      killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
    }, timeoutMs)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve({ code, stdout, stderr, timedOut, pid })
    }

    child.on('error', (error: Error) => {
      stderr += String(error.message)
      finish(null)
    })

    // 'close' fires after the process has exited AND its stdio has closed.
    // 'exit' would fire first and is not proof the descendants are reaped.
    child.on('close', (code) => finish(code))
  })
}

export function runGit(args: string[], options: SuperviseOptions): Promise<SupervisedResult> {
  return runSupervised('git', args, {
    ...options,
    timeoutMs: options.timeoutMs ?? 30_000,
    env: { ...NON_INTERACTIVE_GIT_ENV, ...(options.env ?? {}) }
  })
}
