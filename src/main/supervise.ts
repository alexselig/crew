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

/** Wave 6, F-12 (A11): git reads its repository location from the
 *  environment, and every one of these variables OVERRIDES the `cwd` a
 *  caller chose. A stray `GIT_INDEX_FILE` inherited from whatever launched
 *  Crew made a merge in the conductor's own worktree write the user's index
 *  instead — and the merge still reported success, because git did exactly
 *  what it was told. The ownership guard proves a *directory* is ours; it
 *  cannot prove the environment is. So the conductor's git runs with these
 *  removed, always.
 *
 *  Deliberately absent: `GIT_CEILING_DIRECTORIES` (it only narrows git's
 *  upward search, which is the safe direction, and the guard's own tests
 *  rely on it) and the author/committer identity variables (they decide
 *  nothing about which repository is written). */
export const REPO_LOCAL_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_INDEX_VERSION',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_GRAFT_FILE',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX'
] as const

export interface SuperviseOptions {
  cwd: string
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL. */
  graceMs?: number
  env?: Record<string, string>
  /** Names removed from the child's environment AFTER `env` is merged in.
   *  Spawning with `env` set to a value the child treats as "unset" is not
   *  possible — an empty string is still a set variable to git — so the key
   *  has to be deleted outright. */
  unsetEnv?: readonly string[]
}

export interface SupervisedResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The child's pid. On POSIX it is also its process-group id (detached:
   *  true); on Windows it is the root of the tree taskkill /T walks. */
  pid: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_GRACE_MS = 3_000
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

const IS_WINDOWS = process.platform === 'win32'

/** Windows has no process groups and no signals: `process.kill(-pid, …)`
 *  fails outright, and `child.kill()` reaches the DIRECT child only. A
 *  timed-out `sh -c 'git … &'` therefore left its descendants running AND
 *  held the inherited stdout/stderr pipes open, so `close` never fired and
 *  this promise never settled — the publication lock stayed held for as long
 *  as the orphan lived. `taskkill /T /F` is the platform's own answer: it
 *  walks the child's process tree by parent-pid and terminates all of it,
 *  which both matches the POSIX group kill's intent and closes the pipes.
 *
 *  Fire-and-forget by design. Every failure mode is one the POSIX path also
 *  tolerates silently (the tree is already gone; taskkill is missing from a
 *  stripped PATH), and the timeout escalation must not itself be able to
 *  throw. The `error` listener is not optional: an unhandled `error` event
 *  on a ChildProcess is an uncaught exception, not a rejected promise. */
const killProcessTreeOnWindows = (pid: number): void => {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.on('error', () => {
      /* taskkill unavailable; nothing better to try */
    })
    killer.unref()
  } catch {
    /* spawn itself refused; nothing better to try */
  }
}

export function runSupervised(
  command: string,
  args: string[],
  options: SuperviseOptions
): Promise<SupervisedResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const env: Record<string, string | undefined> = { ...process.env, ...(options.env ?? {}) }
  // After the merge, so an explicit `env` entry can never re-introduce a
  // name the caller also asked to remove.
  for (const name of options.unsetEnv ?? []) delete env[name]

  return new Promise<SupervisedResult>((resolve) => {
    // detached: true gives the child its own process group whose pgid is its
    // pid, so process.kill(-pid) reaches every descendant it spawned.
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env,
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
      if (IS_WINDOWS) {
        // No signals, no groups — see killProcessTreeOnWindows. SIGTERM and
        // SIGKILL collapse into the same forced tree kill, because Windows
        // offers no graceful equivalent to ask for; the grace timer below
        // simply retries, which is harmless once the tree is already gone.
        killProcessTreeOnWindows(pid)
        return
      }
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
    env: { ...NON_INTERACTIVE_GIT_ENV, ...(options.env ?? {}) },
    unsetEnv: [...REPO_LOCAL_GIT_ENV, ...(options.unsetEnv ?? [])]
  })
}
