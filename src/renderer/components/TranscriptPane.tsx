import { useEffect, useMemo, useState } from 'react'
import type { CharacterDef } from '../../shared/types'
import { Transcript } from '../transcript'
import type { TranscriptBlock, PermissionResolution } from '../transcript'
import { DEMO_BLOCKS_DEBUG } from '../transcript/fixtures'
import { getTranscript } from '../terminal/facade'
import { previewToken } from '../preview-bus'
import './TranscriptPane.css'

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
  character,
  agentLabel
}: {
  sessionId: string
  /** Whether the Crew engine (which produces transcript blocks) is active. */
  enhanced: boolean
  character?: CharacterDef
  agentLabel?: string
}): JSX.Element {
  const [blocks, setBlocks] = useState<TranscriptBlock[]>(() =>
    DEMO ? DEMO_BLOCKS_DEBUG : getTranscript(sessionId)
  )

  useEffect(() => {
    if (DEMO) return
    const tick = (): void => setBlocks(getTranscript(sessionId))
    tick()
    const t = setInterval(tick, 400)
    return () => clearInterval(t)
  }, [sessionId])

  const handlers = useMemo(
    () => ({
      // Numbered choices: write the option + Enter to the session (the parser
      // will map option ids to the CLI's 1-based indices once it lands).
      onDecide: (_blockId: string, optionId: string): void =>
        window.crew.sendInput(sessionId, `${optionId}\r`),
      // Approvals reuse the raw terminal's y/n convention.
      onPermission: (_blockId: string, res: PermissionResolution): void =>
        window.crew.sendInput(sessionId, `${res === 'deny' ? 'n' : 'y'}\r`),
      onOpenImage: (blockId: string): void => {
        const b = blocks.find((x) => x.id === blockId)
        if (b && b.kind === 'image') void previewToken(sessionId, b.src)
      }
    }),
    [sessionId, blocks]
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
