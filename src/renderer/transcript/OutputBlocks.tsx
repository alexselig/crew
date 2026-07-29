import { useState } from 'react'
import type {
  ErrorBlock,
  FileDiffBlock,
  ImageBlock,
  PlanBlock,
  ToolRunBlock,
  TranscriptHandlers
} from './types'
import { BlockFrame, fmtDuration } from './BlockFrame'

/** A command the agent ran: header always visible, output folds open on click. */
export function ToolRun({ block }: { block: ToolRunBlock }): JSX.Element {
  const running = block.exitCode == null
  // Auto-expand failures; successes stay folded.
  const [open, setOpen] = useState(() => block.exitCode != null && block.exitCode !== 0)
  const dur = fmtDuration(block.durationMs)
  return (
    <BlockFrame variant="tool" tick="$" meta={<>ran command{dur && ` · ${dur}`}</>}>
      <div className="tr-card">
        <button
          className="tr-tool__head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={!block.output}
        >
          <span className="tr-tool__cmd">
            <span className="tr-tool__ps1">$</span>
            {block.command}
          </span>
          <span
            className={`tr-tool__exit ${
              running ? 'tr-tool__exit--running' : block.exitCode === 0 ? 'tr-tool__exit--ok' : 'tr-tool__exit--bad'
            }`}
          >
            {running ? 'RUNNING' : `EXIT ${block.exitCode}`}
          </span>
        </button>
        {open && block.output && <pre className="tr-tool__out">{block.output}</pre>}
      </div>
    </BlockFrame>
  )
}

/** File edit as a compact unified diff with line-number gutter. */
export function FileDiff({ block }: { block: FileDiffBlock }): JSX.Element {
  const adds = block.lines.filter((l) => l.op === '+').length
  const dels = block.lines.filter((l) => l.op === '-').length
  return (
    <BlockFrame variant="diff" tick="±" meta="edited file">
      <div className="tr-card">
        <div className="tr-diff__head">
          <span>{block.file}</span>
          <span className="tr-diff__count">
            <span className="tr-diff__add">+{adds}</span> <span className="tr-diff__del">−{dels}</span>
          </span>
        </div>
        <div className="tr-diff__body">
          {block.lines.map((l, i) => (
            <div
              key={i}
              className={`tr-dl ${l.op === '+' ? 'tr-dl--add' : l.op === '-' ? 'tr-dl--del' : 'tr-dl--ctx'}`}
            >
              <span className="tr-dl__ln">{l.ln}</span>
              <span className="tr-dl__tx">
                {l.op === ' ' ? '' : l.op}
                {l.op === ' ' ? l.text : `  ${l.text}`.slice(1)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </BlockFrame>
  )
}

/** Screenshot / rendered preview emitted by the agent. */
export function ImageOutput({
  block,
  handlers
}: {
  block: ImageBlock
  handlers?: TranscriptHandlers
}): JSX.Element {
  return (
    <BlockFrame variant="image" tick="▣" meta={<>screenshot{block.alt && ` · ${block.alt}`}</>}>
      <div className="tr-card tr-img">
        <img className="tr-img__pic" src={block.src} alt={block.alt ?? ''} />
        {(block.caption || handlers?.onOpenImage) && (
          <div className="tr-img__cap">
            {block.caption}
            {handlers?.onOpenImage && (
              <button className="tr-img__open" onClick={() => handlers.onOpenImage?.(block.id)}>
                Open full size
              </button>
            )}
          </div>
        )}
      </div>
    </BlockFrame>
  )
}

/** Failure with preformatted detail and optional fix actions. */
export function ErrorCard({
  block,
  handlers
}: {
  block: ErrorBlock
  handlers?: TranscriptHandlers
}): JSX.Element {
  return (
    <BlockFrame variant="error" tick="×" meta="error">
      <div className="tr-err">
        <div className="tr-err__msg">{block.title}</div>
        {block.detail && <pre className="tr-err__detail">{block.detail}</pre>}
        {(block.hint || block.actions?.length) && (
          <div className="tr-err__fix">
            {block.hint && <span>{block.hint} </span>}
            {block.actions?.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ' · '}
                <button className="tr-err__act" onClick={() => handlers?.onAction?.(block.id, a.id)}>
                  {a.label}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </BlockFrame>
  )
}

const PLAN_GLYPH = { done: '✓', active: '◐', todo: '○' } as const

/** The agent's running todo list. */
export function Plan({ block }: { block: PlanBlock }): JSX.Element {
  const done = block.items.filter((i) => i.status === 'done').length
  return (
    <BlockFrame variant="plan" tick="☰" meta={`plan · ${done} of ${block.items.length}`}>
      <div className="tr-plan">
        {block.items.map((item) => (
          <div key={item.id} className={`tr-plan__item tr-plan__item--${item.status}`}>
            <span className="tr-plan__st">{PLAN_GLYPH[item.status]}</span>
            {item.text}
          </div>
        ))}
      </div>
    </BlockFrame>
  )
}
