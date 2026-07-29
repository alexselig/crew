import type { DecisionBlock, PermissionBlock, TranscriptHandlers } from './types'
import { BlockFrame } from './BlockFrame'

/**
 * A decision the agent needs the human to make. Unresolved decisions get the
 * attention treatment (inverted ivory chip — the loudest thing on screen, same
 * grammar as the WAITING tab badge). Once answered, the card goes quiet and the
 * chosen option stays highlighted in cobalt.
 */
export function Decision({
  block,
  handlers,
  active
}: {
  block: DecisionBlock
  handlers?: TranscriptHandlers
  /** True when this is the decision the transcript's number keys target. */
  active?: boolean
}): JSX.Element {
  const resolved = block.resolvedOptionId != null
  return (
    <BlockFrame variant="ask" tick="?" meta={resolved ? 'decided' : 'blocked on you'}>
      <div className={`tr-ask ${resolved ? 'tr-ask--resolved' : ''}`}>
        <span className="tr-ask__tag">{resolved ? 'Answered' : 'Waiting for you'}</span>
        <div className="tr-ask__q">{block.question}</div>
        {block.options.map((opt, i) => (
          <button
            key={opt.id}
            className={`tr-opt ${block.resolvedOptionId === opt.id ? 'tr-opt--sel' : ''}`}
            disabled={resolved}
            onClick={() => handlers?.onDecide?.(block.id, opt.id)}
          >
            <span className="tr-opt__key">{i + 1}</span>
            <span>
              <span className="tr-opt__lbl">{opt.label}</span>
              {opt.detail && <span className="tr-opt__sub">{opt.detail}</span>}
            </span>
          </button>
        ))}
        {!resolved && active && (
          <div className="tr-ask__hint">
            Click an option or press <kbd>1</kbd>–<kbd>{block.options.length}</kbd>
          </div>
        )}
      </div>
    </BlockFrame>
  )
}

/** An approval gate before the agent runs a command. */
export function Permission({
  block,
  handlers
}: {
  block: PermissionBlock
  handlers?: TranscriptHandlers
}): JSX.Element {
  const resolved = block.resolution != null
  const resolve = (r: 'deny' | 'once' | 'always') => handlers?.onPermission?.(block.id, r)
  return (
    <BlockFrame variant="ask" tick="!" meta={resolved ? 'resolved' : 'blocked on you'}>
      <div className={`tr-perm ${resolved ? 'tr-perm--resolved' : ''}`}>
        <span className="tr-ask__tag" style={{ margin: 0 }}>
          Approve
        </span>
        <span>
          {block.actor ?? 'Agent'} wants to run <code className="tr-perm__cmd">{block.command}</code>
        </span>
        {resolved ? (
          <span className="tr-perm__done">
            {block.resolution === 'deny' ? 'denied' : block.resolution === 'once' ? 'allowed once' : 'always allowed'}
          </span>
        ) : (
          <span className="tr-perm__btns">
            <button className="tr-btn" onClick={() => resolve('deny')}>
              Deny
            </button>
            <button className="tr-btn" onClick={() => resolve('once')}>
              Once
            </button>
            <button className="tr-btn tr-btn--go" onClick={() => resolve('always')}>
              Always allow
            </button>
          </span>
        )}
      </div>
    </BlockFrame>
  )
}
