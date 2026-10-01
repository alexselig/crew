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

/** What the new-workspace dialog hands back. `conducted` false means every
 *  other field is irrelevant — a standard workspace is just a name. Declared
 *  here rather than beside the dialog so the decision this choice leads to
 *  (planNewWorkspace, below) can be tested without React. */
export interface NewWorkspaceChoice {
  name: string
  conducted: boolean
  presetId: string
  cwd: string
  prompt: string
}

/** What creating a workspace leads to: at most one session to start, and at
 *  most one workspace to make active. */
export interface NewWorkspacePlan {
  /** The workspace to make active, or null to leave the current filter
   *  alone. A conducted workspace activates itself: the user is about to be
   *  dropped into its conductor, and a conductor sitting in a workspace that
   *  is not the active one renders no conductor UI at all. */
  activateWorkspaceId: string | null
  /** The conductor session to create, or null when there is none to create. */
  session: CreateSessionRequest | null
}

/**
 * The session request for a new conducted workspace's conductor.
 *
 * Returns null when the preset is unknown rather than falling back to a
 * default shell: a conductor that is secretly a bare shell looks like it
 * started and then silently never plans anything. The same fail-closed rule
 * the lane session bridge follows (see main/conductor-sessions.ts). An empty
 * cwd is refused for the same reason: session-manager.create resolves one to
 * the home directory, so the conductor would start, read the wrong tree, and
 * plan work for a repository nobody asked about.
 */
export function conductorSessionRequest(
  workspace: Workspace,
  preset: Preset | undefined,
  start: ConductorStart
): CreateSessionRequest | null {
  if (!preset || typeof preset.command !== 'string' || preset.command.trim() === '') return null
  const prompt = start.prompt.trim()
  if (prompt === '') return null
  const cwd = typeof start.cwd === 'string' ? start.cwd.trim() : ''
  if (cwd === '') return null
  return {
    presetId: preset.id,
    command: preset.command,
    args: [...(preset.args ?? [])],
    cwd,
    label: conductorLabel(workspace.name),
    initialPrompt: prompt,
    // Membership is set at creation, not afterwards: a conductor that exists
    // for a moment outside its own workspace shows up in "All Sessions" as an
    // orphan, and anything watching the workspace sees it arrive empty.
    workspaceIds: [workspace.id]
  }
}

/**
 * Everything that follows from a workspace having just been created: which
 * session to start, and which workspace to make active.
 *
 * Both halves belong together because the conducted arm is only coherent as
 * a pair. Creating the conductor without activating its workspace leaves the
 * user looking at a session whose conductor panel is hidden, which is how
 * this feature first shipped.
 *
 * Returns null when a conducted workspace's conductor cannot be built, so
 * the caller reports a failure rather than silently leaving an empty
 * workspace behind.
 */
export function planNewWorkspace(
  created: Workspace,
  choice: NewWorkspaceChoice,
  presets: readonly Preset[]
): NewWorkspacePlan | null {
  // A standard workspace is just a name. Nothing starts, and the view the
  // user was looking at is left where it was.
  if (!choice.conducted) return { activateWorkspaceId: null, session: null }
  const session = conductorSessionRequest(
    created,
    presets.find((p) => p.id === choice.presetId),
    { cwd: choice.cwd, prompt: choice.prompt }
  )
  if (!session) return null
  return { activateWorkspaceId: created.id, session }
}

/** The message a submission discarded by conductorWorkStillApplies carries.
 *  Phrased as the thing to do next, because the user cannot tell from the
 *  dialog alone that the workspace moved out from under it. */
export const CONDUCTOR_WORKSPACE_CHANGED =
  'the workspace changed while this was open — reopen the conductor in the workspace you mean to compose for'

/**
 * Whether conductor work begun in one workspace may still act on it.
 *
 * A composer or a loaded plan is a draft for one particular workspace, but
 * it outlives a workspace switch: the app menu's Change Workspace works
 * while a modal is up, and compose names the workspace at submit time.
 * Leaving conducted A for conducted B satisfies every conductedness check
 * there is — main's included, because B really is conducted — and the draft
 * written for A would then be appended to B's live runtime as real
 * worktrees and real agent sessions, in a workspace the user was not even
 * looking at. Identity decides, not conductedness.
 *
 * A draft with no workspace behind it (All Sessions) has nothing to compose
 * into, so it never applies.
 */
export function conductorWorkStillApplies(openedIn: string | null, active: string | null): boolean {
  return openedIn !== null && openedIn === active
}
