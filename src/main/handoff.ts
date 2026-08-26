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
  contextMode: 'transcript' | 'brief'
  resumeArgs?: string[]
}): RestoreContext {
  const { agentSessionId, resume, contextMode, resumeArgs } = opts
  const supersede: RestoreContext = { agentSessionId: undefined, priorSessionId: agentSessionId, extraArgs: [] }
  if (!resume) return supersede
  if (contextMode === 'brief' && agentSessionId) return supersede
  return { agentSessionId, priorSessionId: undefined, extraArgs: resumeArgs ?? [] }
}

