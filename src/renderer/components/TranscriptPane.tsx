import { useEffect, useMemo, useState } from 'react'
import type { CharacterDef } from '../../shared/types'
import { Transcript } from '../transcript'
import type { TranscriptBlock, PermissionResolution } from '../transcript'
import type { AgentBlock } from '../../shared/agent-events'
import { DEMO_BLOCKS_DEBUG } from '../transcript/fixtures'
import { getTranscript } from '../terminal/facade'
import './TranscriptPane.css'

// Compile-time guard: the shared parser's blocks are rendered directly as the
// renderer's TranscriptBlock, so every AgentBlock must remain assignable to one.
function assertBlockShape<_T extends TranscriptBlock>(): void {}
assertBlockShape<AgentBlock>()

/** Dev flag: render every block kind from fixtures so the design can be
 *  inspected without a live session. Set `localStorage['crew.transcriptDemo']='1'`. */
const DEMO = ((): boolean => {
  try {
    return localStorage.getItem('crew.transcriptDemo') === '1'
  } catch {
    return false
  }
})()

/**
 * The typed Transcript as a read layer over a session. Blocks are produced by
 * the enhanced terminal engine (from the human's submitted commands + OSC 133
 * command results); this pane just polls them and wires the human actions back
 * to the session PTY. The raw terminal remains the source of truth.
 */
export function TranscriptPane({
  sessionId,
  enhanced,
  agentSessionId,
  character,
  agentLabel
}: {
  sessionId: string
  /** Whether the Crew engine (which produces transcript blocks) is active. */
  enhanced: boolean
  /** The agent's own session id (Copilot CLI), used to read its structured
   *  event log for a high-fidelity transcript. Undefined for shell sessions. */
  agentSessionId?: string
  character?: CharacterDef
  agentLabel?: string
}): JSX.Element {
  const [blocks, setBlocks] = useState<TranscriptBlock[]>(() =>
    DEMO ? DEMO_BLOCKS_DEBUG : getTranscript(sessionId)
  )

  useEffect(() => {
    if (DEMO) return
    let alive = true
    let sig = ''
    const tick = async (): Promise<void> => {
      // Prefer the agent's own event log (clean prose + tools + reasoning +
      // images); fall back to the terminal-derived transcript when there is no
      // log (shell/Claude sessions, or before the first event is written).
      let next: TranscriptBlock[] = []
      if (agentSessionId) {
        try {
          next = await window.crew.getAgentTranscript(agentSessionId)
        } catch {
          next = []
        }
      }
      if (next.length === 0) next = getTranscript(sessionId)
      if (!alive) return
      // Cheap change signature so we don't re-render (and re-decode images) when
      // nothing meaningful changed between polls.
      const last = next[next.length - 1]
      const nextSig = `${next.length}|${last?.id ?? ''}|${
        last && 'exitCode' in last ? last.exitCode : ''
      }|${last && 'text' in last ? last.text.length : ''}`
      if (nextSig !== sig) {
        sig = nextSig
        setBlocks(next)
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 900)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [sessionId, agentSessionId])

  const handlers = useMemo(
    () => ({
      // Numbered choices: write the option + Enter to the session (the parser
      // will map option ids to the CLI's 1-based indices once it lands).
      onDecide: (_blockId: string, optionId: string): void =>
        window.crew.sendInput(sessionId, `${optionId}\r`),
      // Approvals reuse the raw terminal's y/n convention.
      onPermission: (_blockId: string, res: PermissionResolution): void =>
        window.crew.sendInput(sessionId, `${res === 'deny' ? 'n' : 'y'}\r`)
      // No onOpenImage: transcript images are inlined data: URIs (agent
      // screenshots + resolved attachments), which the asset-token previewer
      // can't resolve. Omitting it makes ImageOutput use its built-in fullscreen
      // lightbox, which renders data: URIs directly.
    }),
    [sessionId]
  )

  if (!DEMO && !enhanced) {
    return (
      <div className="transcript-pane transcript-pane--empty">
        Turn on <b>Beta: Enhanced Terminal Interface</b> in Settings to use the typed transcript.
      </div>
    )
  }
  if (!DEMO && blocks.length === 0) {
    return (
      <div className="transcript-pane transcript-pane--empty">
        Run a command — your session appears here as typed blocks.
      </div>
    )
  }

  return (
    <div className="transcript-pane">
      <Transcript
        blocks={blocks}
        character={character}
        agentLabel={agentLabel}
        handlers={handlers}
        className="transcript-fill"
      />
    </div>
  )
}
