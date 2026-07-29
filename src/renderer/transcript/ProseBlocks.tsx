import { useState } from 'react'
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

/** Collapsed by default; the reasoning is there when you want it, quiet when you don't. */
export function Thinking({ block }: { block: ThinkingBlock }): JSX.Element {
  const [open, setOpen] = useState(false)
  const secs = block.durationMs != null ? Math.max(1, Math.round(block.durationMs / 1000)) : null
  return (
    <BlockFrame variant="thinking" tick="·">
      <div className={open ? 'tr-think--open' : ''}>
        <button className="tr-think__bar" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="tr-think__chev">▸</span>
          {secs != null ? `Thought for ${secs}s` : 'Thinking'}
        </button>
        {open && <div className="tr-think__body">{block.body}</div>}
      </div>
    </BlockFrame>
  )
}
