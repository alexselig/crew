// Crew shell integration ("crew-hook"). Emits OSC 133 (FinalTerm) semantic
// prompt marks — A (prompt start), C (command run), D;exit (command done) — so
// the Enhanced Terminal can build command blocks, jump-to-prompt targets, and
// exit-code indicators for plain shell sessions.
//
// SAFETY: the scripts always source the user's own startup files FIRST and only
// add non-destructive hooks; ZDOTDIR is restored before the interactive prompt.
// The scripts are embedded here and materialized to <userData>/crew-hook at
// runtime, so there are no packaged-asset path concerns. Injection is opt-in
// (only the "Shell" preset while the Enhanced Terminal setting is on) and POSIX
// only (zsh/bash); anything else is left untouched.

import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

// NOTE: backslashes are doubled so the TS template yields literal \033 / \007
// (ESC / BEL) in the generated shell text.
const ZSHENV = `# Crew shell integration (zsh) — chain to the user's real startup files.
CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zshenv" ] && source "$CREW_ZDOTDIR/.zshenv"
`

const ZPROFILE = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zprofile" ] && source "$CREW_ZDOTDIR/.zprofile"
`

const ZLOGIN = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zlogin" ] && source "$CREW_ZDOTDIR/.zlogin"
`

const ZSHRC = `CREW_ZDOTDIR="\${CREW_ZDOTDIR:-$HOME}"
[ -f "$CREW_ZDOTDIR/.zshrc" ] && source "$CREW_ZDOTDIR/.zshrc"

# OSC 133 semantic prompt marks (interactive shells only).
if [[ -o interactive ]]; then
  __crew_osc() { printf '\\033]133;%s\\007' "$1" }
  __crew_precmd() { local __crew_e=$?; __crew_osc "D;\${__crew_e}"; __crew_osc "A" }
  __crew_preexec() { __crew_osc "C" }
  if autoload -Uz add-zsh-hook 2>/dev/null; then
    add-zsh-hook precmd __crew_precmd
    add-zsh-hook preexec __crew_preexec
  fi
fi

# Restore the user's ZDOTDIR so subshells and tools see the real value.
if [ "$CREW_ZDOTDIR" = "$HOME" ]; then
  unset ZDOTDIR
else
  export ZDOTDIR="$CREW_ZDOTDIR"
fi
`

const BASHRC = `# Crew shell integration (bash) — sourced via \`bash --rcfile\`.
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

if [[ $- == *i* ]]; then
  __crew_osc() { printf '\\033]133;%s\\007' "$1"; }
  __crew_precmd() { local __crew_e=$?; __crew_osc "D;\${__crew_e}"; __crew_osc "A"; }
  case ";\${PROMPT_COMMAND};" in
    *";__crew_precmd;"*) ;;
    *) PROMPT_COMMAND="__crew_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
  __crew_preexec() {
    [ -n "$COMP_LINE" ] && return
    case "$BASH_COMMAND" in __crew_precmd|__crew_preexec) return ;; esac
    __crew_osc "C"
  }
  trap '__crew_preexec' DEBUG
fi
`

export interface HookInjection {
  env?: Record<string, string>
  extraArgs?: string[]
}

/** Materialize the hook scripts under <userData>/crew-hook; returns the dir.
 *  Best-effort — on any IO error returns the path anyway (injection callers
 *  tolerate missing files: the shell simply starts without marks). */
export function ensureCrewHookDir(userDataDir: string): string {
  const dir = join(userDataDir, 'crew-hook')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.zshenv'), ZSHENV)
    writeFileSync(join(dir, '.zprofile'), ZPROFILE)
    writeFileSync(join(dir, '.zlogin'), ZLOGIN)
    writeFileSync(join(dir, '.zshrc'), ZSHRC)
    writeFileSync(join(dir, 'crew-hook.bash'), BASHRC)
  } catch {
    /* best-effort */
  }
  return dir
}

/** Compute the env / arg injection to install shell integration for `command`,
 *  or null when the shell is unsupported (e.g. PowerShell, fish). */
export function crewHookFor(command: string, hookDir: string): HookInjection | null {
  // Login shells arrive as "-zsh"/"-bash"; normalise the leading dash.
  const shell = basename(command).replace(/^-/, '').toLowerCase()
  if (shell === 'zsh') {
    return { env: { ZDOTDIR: hookDir, CREW_ZDOTDIR: process.env.ZDOTDIR || homedir() } }
  }
  if (shell === 'bash') {
    return { extraArgs: ['--rcfile', join(hookDir, 'crew-hook.bash')] }
  }
  return null
}
