import type { SessionSet } from '../../shared/types'

interface Props {
  sets: SessionSet[]
  /** Launch (resume) the named set. */
  onLaunch: (name: string) => void
  /** When provided, each chip gets a delete (✕) affordance. */
  onDelete?: (name: string) => void
  /** Placeholder shown when there are no saved sets. */
  emptyText?: string
}

/**
 * Presentational row of saved session-set chips. Shared by the New Session
 * modal and the empty-state launcher so the chip UI never diverges.
 */
export function SessionSetChips({ sets, onLaunch, onDelete, emptyText }: Props): JSX.Element {
  return (
    <div className="sets__row">
      {sets.length === 0 && emptyText && <span className="sets__empty">{emptyText}</span>}
      {sets.map((s) => (
        <span key={s.name} className="set-chip">
          <button
            type="button"
            className="set-chip__launch"
            title={`Resume ${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}`}
            onClick={() => onLaunch(s.name)}
          >
            ▶ {s.name} · {s.sessions.length}
          </button>
          {onDelete && (
            <button
              type="button"
              className="set-chip__x"
              title="Delete set"
              onClick={() => onDelete(s.name)}
            >
              ✕
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
