import type { Agent } from './types'

export function makeAgentId(): string {
  return 'ag_' + Math.random().toString(36).slice(2, 10)
}
export function makeRunId(): string {
  return 'run_' + Math.random().toString(36).slice(2, 10)
}

/** Built-in specialists. Read-first personas explicitly forbid edits. */
export const BUILTIN_AGENTS: Agent[] = [
  {
    id: 'ag_ux',
    name: 'UX Critique',
    icon: 'spark',
    color: '#c879ff',
    base: 'copilot-cli',
    writes: false,
    contextMode: 'cwd',
    order: 0,
    builtin: true,
    persona:
      'You are a senior product designer doing a UX critique. Inspect the app/code in this working directory (read only — do NOT edit any files). Report the top usability, hierarchy, accessibility and copy issues, each with a concrete fix. Be specific and concise.'
  },
  {
    id: 'ag_review',
    name: 'Code Review',
    icon: 'check',
    color: '#3fb950',
    base: 'copilot-cli',
    writes: false,
    contextMode: 'cwd',
    order: 1,
    builtin: true,
    persona:
      'You are a meticulous staff engineer. Review the recent changes in this repository (read only — do NOT edit). Report high-confidence correctness bugs, risky logic, and design issues, with file references. Skip style nits.'
  },
  {
    id: 'ag_sec',
    name: 'Security Review',
    icon: 'shield',
    color: '#e5a13a',
    base: 'copilot-cli',
    writes: false,
    contextMode: 'cwd',
    order: 2,
    builtin: true,
    persona:
      'You are an application security reviewer. Read the code in this working directory (read only — do NOT edit). Report only high-confidence, exploitable vulnerabilities with severity, location and remediation.'
  },
  {
    id: 'ag_docs',
    name: 'Doc Writer',
    icon: 'doc',
    color: '#5f79ff',
    base: 'copilot-cli',
    writes: true,
    contextMode: 'cwd',
    order: 3,
    builtin: true,
    persona:
      'You are a technical writer. Draft or update clear documentation for the code in this working directory. Prefer a concise README/section with usage examples.'
  }
]

// Copilot tools that write/mutate — denied for read-first agents so a headless
// run never edits files and never blocks on an approval prompt.
const COPILOT_WRITE_TOOLS = ['write', 'edit', 'shell']
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'Bash']

function buildPrompt(agent: Agent, task: string, extra: string): string {
  const parts = [agent.persona]
  if (task.trim()) parts.push('Task: ' + task.trim())
  if (extra.trim()) parts.push('Context:\n' + extra.trim())
  return parts.join('\n\n')
}

/**
 * Argv (after the base command) for a headless one-shot run. copilot/claude both
 * print and exit under -p. Read-first agents deny write tools; writes agents get
 * full autonomy so nothing blocks on approval.
 */
export function buildAgentInvocation(
  base: { command: string; args: string[] },
  agent: Agent,
  task: string,
  extra: string
): { args: string[] } {
  const prompt = buildPrompt(agent, task, extra)
  const cmd = base.command
  if (cmd.includes('claude')) {
    const args = ['-p', prompt, '--output-format', 'text']
    if (agent.writes) args.push('--dangerously-skip-permissions')
    else args.push('--disallowedTools', CLAUDE_WRITE_TOOLS.join(','))
    return { args }
  }
  // default: copilot-style
  const args = ['-p', prompt]
  if (agent.writes) args.push('--allow-all-tools')
  else args.push('--allow-all-paths', '--deny-tool', COPILOT_WRITE_TOOLS.join(','))
  return { args }
}

export function validateAgent(a: Partial<Agent>): string | null {
  if (!a.name || !a.name.trim()) return 'Name is required.'
  if (!a.persona || !a.persona.trim()) return 'Persona is required.'
  if (!a.base) return 'A base agent is required.'
  return null
}

export function upsertAgent(list: readonly Agent[], a: Agent): Agent[] {
  const exists = list.some((x) => x.id === a.id)
  return exists ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]
}
export function deleteAgent(list: readonly Agent[], id: string): Agent[] {
  return list.filter((x) => x.id !== id)
}
export function reorderAgents(list: readonly Agent[], orderedIds: readonly string[]): Agent[] {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  return list
    .map((a) => ({ ...a, order: rank.has(a.id) ? (rank.get(a.id) as number) : a.order }))
    .sort((x, y) => x.order - y.order)
}
