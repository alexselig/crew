// Built-in launch presets. Each carries best-guess detection defaults; the
// detection engine also has a quiescence fallback so the red dot still appears
// even when a precise prompt regex hasn't been calibrated yet (SPEC §6, §16).

import type { Preset } from '../shared/types'

// Matches the common "are you sure / allow this?" family across CLI agents.
const APPROVAL =
  '(\\(y/n\\)|\\[y/N\\]|\\by/n\\b|\\bY/n\\b|Do you want|Would you like to proceed|' +
  'Allow\\b|permission to|Proceed\\?|Continue\\?|Approve\\b|Yes/No)'

function defaultShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

export function builtinPresets(): Preset[] {
  return [
    {
      // Copilot CLI is the default preset for new sessions (listed first).
      id: 'copilot-cli',
      name: 'Copilot CLI',
      command: 'copilot',
      args: [],
      approvalRegex: APPROVAL,
      approveKeys: 'y\r',
      denyKeys: 'n\r',
      installHint: 'npm i -g @github/copilot',
      resumeArgs: ['--continue'],
      quietMs: 800,
      confirmMs: 400,
      // Agent produced output (since your last input) then went quiet for >1.5s
      // with no recognized prompt ⇒ almost certainly your turn. The detector
      // separately suppresses this while the agent is still answering you.
      assumeWaitingAfterMs: 1500
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: [],
      approvalRegex: APPROVAL,
      approveKeys: 'y\r',
      denyKeys: 'n\r',
      installHint: 'Install from https://claude.com/claude-code',
      resumeArgs: ['--continue'],
      quietMs: 800,
      confirmMs: 400,
      assumeWaitingAfterMs: 1500
    },
    {
      id: 'shell',
      name: 'Shell',
      command: defaultShell(),
      args: [],
      // A shell sitting at its prompt IS waiting for you — match a trailing
      // prompt sigil so the dot appears the instant a command finishes.
      promptRegex: '[$%#>\u276f]\\s*$',
      approvalRegex: '(\\(y/n\\)|\\[y/N\\]|\\by/n\\b)',
      quietMs: 500,
      confirmMs: 0,
      assumeWaitingAfterMs: null
    }
  ]
}

export function getPreset(id: string | null): Preset | null {
  if (!id) return null
  return builtinPresets().find((p) => p.id === id) ?? null
}
