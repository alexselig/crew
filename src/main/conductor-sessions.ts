// Bridges Crew's real SessionManager to the narrow ComposeDeps interface
// conductor-compose.ts needs. Kept as pure injected-dependency wiring (no
// singleton imports) so it stays testable under the node-only vitest env.

import type { SessionManager } from './session-manager'
import type { ComposeDeps } from './conductor-compose'
import { withCopilotModel } from '../shared/copilot-models'

export interface LaneSessionBridgeDeps {
  manager: Pick<SessionManager, 'create' | 'close'>
  /** Resolves a Crew preset id to its launch command/args. Returns null for
   *  anything not registered — createSession below turns that into a reject,
   *  never a fallback shell. */
  resolvePreset: (presetId: string) => { command: string; args: string[] } | null
}

export function createLaneSessionBridge(
  deps: LaneSessionBridgeDeps
): Pick<ComposeDeps, 'createSession' | 'closeSession'> {
  const createSession: ComposeDeps['createSession'] = async (request) => {
    // Fail-closed: an unrecognized presetId must reject and spawn nothing.
    // Falling back to a default shell would silently run the wrong agent
    // inside a lane worktree, and nobody would notice until the lane's
    // output was garbage.
    const preset = deps.resolvePreset(request.presetId)
    if (!preset) {
      throw new Error(
        `conductor: unknown presetId "${request.presetId}" — refusing to create a lane session`
      )
    }
    // A resolved-but-malformed preset (empty command, non-array args) must not
    // reach SessionManager.create: it falls back through
    // `req.command || ... || defaultShell()` and would silently launch a bare
    // shell in the lane worktree instead of the intended agent.
    if (typeof preset.command !== 'string' || preset.command.trim().length === 0) {
      throw new Error(
        `conductor: preset "${request.presetId}" resolved to an empty command — refusing to create a lane session`
      )
    }
    if (!Array.isArray(preset.args)) {
      throw new Error(
        `conductor: preset "${request.presetId}" resolved to non-array args — refusing to create a lane session`
      )
    }
    // ComposeDeps carries `model`, but CreateSessionRequest (SessionManager's
    // own contract) has no field for it. The existing New Session flow
    // (src/renderer/new-session-model.ts: getCopilotLaunchArgs) threads a
    // chosen model the same way: by folding it into the launch args via
    // withCopilotModel(args, model), because Copilot CLI takes the model as
    // a `--model` argv flag rather than a distinct session property. Lanes
    // reuse that exact convention here rather than inventing a second one, so
    // a lane provably runs the requested model instead of silently falling
    // back to the CLI's default.
    const args = request.model != null ? withCopilotModel(preset.args, request.model) : preset.args

    // SessionManager.create is synchronous; ComposeDeps.createSession is
    // async. Wrap it — neither contract changes.
    const info = deps.manager.create({
      presetId: request.presetId,
      command: preset.command,
      args,
      cwd: request.cwd,
      label: request.label
    })

    // SessionManager.create() can catch a synchronous spawn failure
    // internally, mark the SessionInfo it returns as ERROR/'error', and still
    // return normally (see session-manager.ts's `start()` catch block: state
    // = 'ERROR', status = 'error', pid never set — no pty, no live process).
    // Compose is fail-closed: it takes a resolved createSession() as proof of
    // a live lane session and skips rollback accordingly. Reporting success
    // here for a dead session would leave an orphaned lane whose agent never
    // started, so a launch failure must close the dead session and throw
    // instead of returning normally.
    if (info.status !== 'active' || info.state === 'ERROR' || typeof info.pid !== 'number') {
      deps.manager.close(info.id)
      throw new Error(
        `conductor: session for presetId "${request.presetId}" failed to launch` +
          (info.errorMessage ? `: ${info.errorMessage}` : '')
      )
    }

    return { id: info.id }
  }

  const closeSession: ComposeDeps['closeSession'] = (id) => {
    deps.manager.close(id)
  }

  return { createSession, closeSession }
}
