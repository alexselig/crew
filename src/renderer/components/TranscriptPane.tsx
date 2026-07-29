import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
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

/**
 * Prompt composer for the Transcript view: an alternate input surface to the raw
 * terminal. Submitting writes the text + Enter straight to the session PTY (the
 * same bytes typing in the terminal would send), so the agent handles it
 * identically; the human's prompt then appears as a `user` block on the next
 * poll. Enter sends, Shift+Enter inserts a newline.
 */
function Composer({ sessionId }: { sessionId: string }): JSX.Element {
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const send = (): void => {
    const text = draft.replace(/\s+$/, '')
    if (!text) return
    window.crew.sendInput(sessionId, `${text}\r`)
    setDraft('')
    // Reset the auto-grown height after clearing.
    const ta = taRef.current
    if (ta) ta.style.height = 'auto'
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // Auto-grow the textarea up to a few lines, then scroll.
  const onInput = (): void => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`
  }

  return (
    <div className="transcript-composer">
      <textarea
        ref={taRef}
        className="transcript-composer__input"
        placeholder="Send a prompt to the agent…  (Enter to send · Shift+Enter for newline)"
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onInput={onInput}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="transcript-composer__send"
        onClick={send}
        disabled={draft.trim().length === 0}
        title="Send (Enter)"
      >
        Send
      </button>
    </div>
  )
}

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
    let version = ''
    let usingAgent = false

    // Apply a candidate block list only when it meaningfully changed (a cheap
    // signature keeps us from re-rendering — and re-decoding images — on every
    // poll where nothing moved).
    const commit = (next: TranscriptBlock[]): void => {
      const last = next[next.length - 1]
      const nextSig = `${next.length}|${last?.id ?? ''}|${
        last && 'exitCode' in last ? last.exitCode : ''
      }|${last && 'text' in last ? last.text.length : ''}`
      if (nextSig !== sig) {
        sig = nextSig
        setBlocks(next)
      }
    }

    const tick = async (): Promise<void> => {
      // Prefer the agent's own event log (clean prose + tools + reasoning +
      // images). The version token means an unchanged log returns blocks:null,
      // so an idle poll transfers ~30 bytes instead of the full image-heavy list.
      if (agentSessionId) {
        try {
          const res = await window.crew.getAgentTranscript(agentSessionId, version)
          version = res.version
          if (!alive) return
          if (res.blocks && res.blocks.length > 0) {
            usingAgent = true
            commit(res.blocks)
            return
          }
          // Unchanged AND we're already showing the agent transcript: nothing to do.
          if (res.blocks === null && usingAgent) return
          usingAgent = false
        } catch {
          usingAgent = false
        }
      }
      // Fall back to the terminal-derived transcript (shell/Claude sessions, or
      // before the agent writes its first event); refreshed each poll.
      if (alive) commit(getTranscript(sessionId))
    }

    void tick()
    const t = setInterval(() => void tick(), 500)
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
      <div className="transcript-pane">
        <div className="transcript-pane__empty-body">
          Send a prompt below — your session appears here as typed blocks.
        </div>
        <Composer sessionId={sessionId} />
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
      <Composer sessionId={sessionId} />
    </div>
  )
}
