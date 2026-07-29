import { useEffect, useMemo, useRef } from 'react'
import type { CharacterDef } from '../../shared/types'
import type { TranscriptBlock, TranscriptHandlers } from './types'
import { UserPrompt, AgentText, Thinking } from './ProseBlocks'
import { ToolRun, FileDiff, ImageOutput, ErrorCard, Plan } from './OutputBlocks'
import { Decision, Permission } from './AskBlocks'
import './transcript.css'

/**
 * A session's scrollback as a typed block stream on the hairline rail.
 *
 * Owns two conveniences so hosts don't have to:
 * - number keys 1–9 answer the oldest unresolved decision block
 * - the view pins to the bottom while new blocks stream in, unless the human
 *   has scrolled up to read history
 */
export function Transcript({
  blocks,
  character,
  agentLabel,
  handlers,
  className = ''
}: {
  blocks: TranscriptBlock[]
  /** Session character; attributes agent prose and permission asks. */
  character?: CharacterDef
  /** e.g. "claude code" */
  agentLabel?: string
  handlers?: TranscriptHandlers
  className?: string
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Oldest unresolved decision is the keyboard target.
  const activeDecision = useMemo(
    () => blocks.find((b) => b.kind === 'decision' && b.resolvedOptionId == null),
    [blocks]
  )

  useEffect(() => {
    if (!activeDecision || activeDecision.kind !== 'decision') return
    const onKey = (e: KeyboardEvent) => {
      // Don't steal digits from inputs or the terminal.
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > activeDecision.options.length) return
      handlers?.onDecide?.(activeDecision.id, activeDecision.options[n - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDecision, handlers])

  // Pin-to-bottom: follow the stream unless the human scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [blocks])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className={`transcript ${className}`.trim()}>
      {blocks.map((block) => {
        switch (block.kind) {
          case 'user':
            return <UserPrompt key={block.id} block={block} />
          case 'agent':
            return <AgentText key={block.id} block={block} character={character} agentLabel={agentLabel} />
          case 'thinking':
            return <Thinking key={block.id} block={block} />
          case 'tool':
            return <ToolRun key={block.id} block={block} />
          case 'diff':
            return <FileDiff key={block.id} block={block} />
          case 'image':
            return <ImageOutput key={block.id} block={block} handlers={handlers} />
          case 'decision':
            return (
              <Decision
                key={block.id}
                block={block}
                handlers={handlers}
                active={block.id === activeDecision?.id}
              />
            )
          case 'permission':
            return (
              <Permission
                key={block.id}
                block={{ ...block, actor: block.actor ?? character?.name }}
                handlers={handlers}
              />
            )
          case 'error':
            return <ErrorCard key={block.id} block={block} handlers={handlers} />
          case 'plan':
            return <Plan key={block.id} block={block} />
        }
      })}
    </div>
  )
}
