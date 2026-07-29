import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CharacterDef } from '../../shared/types'
import { CharacterArt, hasCharacterArt } from '../character-art'
import type { AgentTextBlock, ThinkingBlock, UserBlock } from './types'
import { BlockFrame, fmtTime } from './BlockFrame'

/**
 * The session character's face for a block tick: the illustrated line-art
 * (tinted with the identity color via currentColor) when it exists, the emoji
 * glyph otherwise, and the ✳ fallback when there's no character at all.
 */
export function CharacterTick({ character, size = 18 }: { character?: CharacterDef; size?: number }): JSX.Element {
  if (!character) return <>✳</>
  if (hasCharacterArt(character.id)) {
    return (
      <span style={{ color: character.color, display: 'flex' }}>
        <CharacterArt id={character.id} size={size} />
      </span>
    )
  }
  return <>{character.glyph}</>
}

/** The human's turn — set in the wordmark serif so it reads as a distinct voice. */
export function UserPrompt({ block }: { block: UserBlock }): JSX.Element {
  const t = fmtTime(block.ts)
  return (
    <BlockFrame variant="user" tick="❯" meta={<>you{t && ` · ${t}`}</>}>
      <div className="tr-user">{block.text}</div>
    </BlockFrame>
  )
}

/** Splits `inline code` out of plain text; paragraphs on blank lines. */
function renderProse(text: string): ReactNode {
  return text.split(/\n{2,}/).map((para, pi) => (
    <p key={pi}>
      {para.split('`').map((seg, i) =>
        i % 2 === 1 ? (
          <code key={i} className="tr-code">
            {seg}
          </code>
        ) : (
          seg
        )
      )}
    </p>
  ))
}

/** Agent prose, attributed to the session's character. */
export function AgentText({
  block,
  character,
  agentLabel
}: {
  block: AgentTextBlock
  character?: CharacterDef
  /** e.g. "claude code" — shown after the character name. */
  agentLabel?: string
}): JSX.Element {
  return (
    <BlockFrame
      variant="agent"
      tick={<CharacterTick character={character} />}
      meta={
        <>
          {character && (
            <span className="tr-actor" style={{ color: character.color }}>
              {character.name}
            </span>
          )}
          {agentLabel && <span>{agentLabel}</span>}
        </>
      }
    >
      <div className="tr-prose">{renderProse(block.text)}</div>
    </BlockFrame>
  )
}

/** Two-hemisphere brain glyph for the thinking tick. Stroke-only, inherits
 *  currentColor so it tints with the tick like the other line-art marks. */
function BrainIcon({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5.5a2.5 2.5 0 0 0-4.9-.7A2.4 2.4 0 0 0 4.3 7 2.4 2.4 0 0 0 3.5 11a2.4 2.4 0 0 0 .8 3.6A2.5 2.5 0 0 0 7 18a2.5 2.5 0 0 0 5 .3Z" />
      <path d="M12 5.5a2.5 2.5 0 0 1 4.9-.7A2.4 2.4 0 0 1 19.7 7a2.4 2.4 0 0 1 .8 4 2.4 2.4 0 0 1-.8 3.6A2.5 2.5 0 0 1 17 18a2.5 2.5 0 0 1-5 .3Z" />
    </svg>
  )
}

/** The agent's reasoning as a compact 2-line card: the brain tick, a "Thought
 *  for Ns" label, and the reasoning clamped to two lines with an inline "Show
 *  more" toggle that appears only when the text actually overflows. */
export function Thinking({ block }: { block: ThinkingBlock }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)
  const secs = block.durationMs != null ? Math.max(1, Math.round(block.durationMs / 1000)) : null

  // Whether the reasoning exceeds two lines (so the toggle is worth showing).
  // Measured only while clamped (open === false); the default is collapsed, so
  // this runs on mount and whenever the body grows during streaming.
  useLayoutEffect(() => {
    const el = textRef.current
    if (!el || open) return
    setOverflows(el.scrollHeight - el.clientHeight > 1)
  }, [block.body, open])

  return (
    <BlockFrame variant="thinking" tick={<BrainIcon />}>
      <div className="tr-think">
        <div className="tr-think__label">{secs != null ? `Thought for ${secs}s` : 'Thinking'}</div>
        <div className={`tr-think__card ${open ? 'is-open' : 'is-clamped'}`}>
          <div ref={textRef} className="tr-think__text">
            {block.body}
          </div>
          {(overflows || open) && (
            <button
              className="tr-think__toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      </div>
    </BlockFrame>
  )
}
