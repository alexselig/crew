import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Where scripts/handoff.mjs writes its briefs. */
export const HANDOFF_DIR = process.env.CREW_HANDOFF_DIR || join(homedir(), '.crew', 'handoffs')

/**
 * Find the handoff brief for a conversation, if one has been generated.
 *
 * Briefs are named `<slug>--<first-8-of-uuid>.md`: the slug keeps the folder
 * readable for a human, the id suffix is what makes the lookup exact. We match
 * on the suffix only, so retitling a brief never breaks the link.
 */
export function briefPathFor(agentSessionId: string | undefined, dir = HANDOFF_DIR): string | null {
  if (!agentSessionId) return null
  const suffix = `--${agentSessionId.slice(0, 8)}.md`
  try {
    const hit = readdirSync(dir).find((f) => f.endsWith(suffix))
    return hit ? join(dir, hit) : null
  } catch {
    // No briefs generated yet: a missing folder is a normal state, not an error.
    return null
  }
}

/**
 * The line typed into a freshly launched agent that is succeeding an older
 * conversation.
 *
 * Deliberately a single line with no trailing carriage return: Crew types it
 * into the prompt but does not submit it, so a restored roster costs nothing
 * until the user actually engages with a session. It stays one line for the
 * same reason broadcast prompts do — an embedded newline reads as Enter.
 */
export function primerFor(briefPath: string): string {
  return (
    `Read ${briefPath} first — it is the context brief for this session, ` +
    `distilled from our previous conversation. Treat it as the current state of ` +
    `the work and continue from there; re-read any files it cites rather than ` +
    `trusting them to be unchanged.`
  )
}

/**
 * The transcript size at which 'auto' stops replaying and starts from a brief.
 *
 * Measured against the agent's own event log. Sized from the real distribution
 * on this machine: the median session log is ~0.1 MB and the 95th percentile is
 * ~5 MB, so 2 MB leaves the overwhelming majority of sessions resuming exactly
 * as they were and catches only the handful whose history has genuinely
 * outgrown a context window.
 */
export const AUTO_BRIEF_BYTES = 2 * 1024 * 1024

export interface RestoreContext {
  agentSessionId?: string
  priorSessionId?: string
  extraArgs: string[]
}

/**
 * Decide how a saved session regains its context on relaunch.
 *
 * The one invariant: a known conversation id is never simply dropped. It comes
 * back either as agentSessionId (we are reattaching to it) or as
 * priorSessionId (a fresh agent is superseding it, brief in hand). Dropping it
 * used to mean the next persist overwrote it with a newly minted id, silently
 * orphaning the transcript.
 */
export function resolveContext(opts: {
  agentSessionId?: string
  resume: boolean
  contextMode: 'transcript' | 'brief' | 'auto'
  resumeArgs?: string[]
  /** Size of the agent's event log, for 'auto'. Undefined = unknown, treated as small. */
  transcriptBytes?: number
  /** Whether a handoff brief exists for this conversation. 'auto' will not
   *  supersede without one, because that would restore nothing at all. */
  hasBrief?: boolean
}): RestoreContext {
  const { agentSessionId, resume, contextMode, resumeArgs, transcriptBytes, hasBrief } = opts
  const supersede: RestoreContext = { agentSessionId: undefined, priorSessionId: agentSessionId, extraArgs: [] }
  if (!resume) return supersede
  if (contextMode === 'brief' && agentSessionId) return supersede
  if (contextMode === 'auto' && agentSessionId) {
    // Replay while the history is short enough to be worth replaying; hand over
    // to the brief once it isn't. Without a brief there is nothing to hand over
    // to, so a long transcript is still better than a blank agent.
    const outgrown = (transcriptBytes ?? 0) >= AUTO_BRIEF_BYTES
    if (outgrown && hasBrief) return supersede
  }
  return { agentSessionId, priorSessionId: undefined, extraArgs: resumeArgs ?? [] }
}

