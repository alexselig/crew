// Small cross-platform helpers so the rest of main/ never hard-codes macOS-only
// assumptions (shell path, window chrome). Crew ships on macOS today and Windows
// via CI; keeping these in one place makes the platform branches explicit.

export const isWindows = process.platform === 'win32'
export const isMac = process.platform === 'darwin'
export const isLinux = process.platform === 'linux'

/**
 * A sensible interactive shell for the current OS, used as the fallback command
 * for a "Shell" session when the request/preset doesn't specify one. Overridable
 * on POSIX via $SHELL. On Windows we default to PowerShell (always present in
 * System32 and resolvable on PATH); users can still pick cmd.exe/pwsh.exe via a
 * preset or the command field.
 */
export function defaultShell(): string {
  if (isWindows) return process.env.CREW_SHELL || 'powershell.exe'
  return process.env.SHELL || (isMac ? '/bin/zsh' : '/bin/bash')
}
