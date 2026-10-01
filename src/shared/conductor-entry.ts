// What a conducted workspace starts life with: one session, the conductor.
//
// Kept apart from the dialog that collects the choice and the manager that
// acts on it, because the interesting decisions here are not about React --
// what the conductor is called, what it is told, and which workspace it
// belongs to -- and those are worth testing without mounting anything.

import type { CreateSessionRequest, Preset, Workspace } from './types'

/** The conductor's label, e.g. "Payments - Conductor". The workspace name is
 *  carried in the label because the session roster is flat: a bare
 *  "Conductor" would be indistinguishable once a second conducted workspace
 *  exists, which is exactly when telling them apart starts to matter. */
export function conductorLabel(workspaceName: string): string {
  return `${workspaceName} - Conductor`
}

export interface ConductorStart {
  /** Where the repository is. */
  cwd: string
  /** What the user wants done, in their words. */
  prompt: string
}

/**
 * The session request for a new conducted workspace's conductor.
 *
 * Returns null when the preset is unknown rather than falling back to a
 * default shell: a conductor that is secretly a bare shell looks like it
 * started and then silently never plans anything. The same fail-closed rule
 * the lane session bridge follows (see main/conductor-sessions.ts).
 */
export function conductorSessionRequest(
  workspace: Workspace,
  preset: Preset | undefined,
  start: ConductorStart
): CreateSessionRequest | null {
  if (!preset || typeof preset.command !== 'string' || preset.command.trim() === '') return null
  const prompt = start.prompt.trim()
  if (prompt === '') return null
  return {
    presetId: preset.id,
    command: preset.command,
    args: [...(preset.args ?? [])],
    cwd: start.cwd,
    label: conductorLabel(workspace.name),
    initialPrompt: prompt,
    // Membership is set at creation, not afterwards: a conductor that exists
    // for a moment outside its own workspace shows up in "All Sessions" as an
    // orphan, and anything watching the workspace sees it arrive empty.
    workspaceIds: [workspace.id]
  }
}
