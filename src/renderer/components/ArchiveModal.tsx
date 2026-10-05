import { useEffect, useState } from 'react'
import type { ArchivedSessionInfo } from '../../shared/types'

interface Props {
  onClose: () => void
  /** Bring a session back onto the roster; resolves once it is live again. */
  onRestored: (id: string) => void
}

/**
 * The archive: sessions put away, kept, and no longer restored on launch.
 *
 * This is the exit the store never had. 117 of 131 sessions were past the
 * stale cutoff and merely *hidden* — still loaded, still restored, still
 * written on every flush — because hiding was the cheap version of a
 * lifecycle. Archiving is the real one, and it is the only place in Crew
 * that can delete a session for good.
 */
export function ArchiveModal({ onClose, onRestored }: Props): JSX.Element {
  const [items, setItems] = useState<ArchivedSessionInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setItems(await window.crew.listArchived())
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function restore(id: string): Promise<void> {
    setBusy(id)
    const info = await window.crew.unarchiveSession(id)
    setBusy(null)
    await refresh()
    if (info) onRestored(id)
  }

  async function remove(item: ArchivedSessionInfo): Promise<void> {
    const name = item.label || 'this session'
    if (!window.confirm(`Delete ${name} permanently? This cannot be undone.`)) return
    setBusy(item.id)
    await window.crew.deleteArchived(item.id)
    setBusy(null)
    await refresh()
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--archive" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Archive</h2>
        <p className="modal__hint modal__hint--tight">
          Archived sessions stay off the roster and are not restored when Crew launches.
          Their conversation is kept, so restoring one picks the thread back up.
        </p>

        {items === null && <p className="sets__empty">Loading…</p>}
        {items !== null && items.length === 0 && (
          <p className="sets__empty">Nothing archived yet.</p>
        )}

        {items !== null && items.length > 0 && (
          <ul className="archive-list">
            {items.map((item) => (
              <li key={item.id} className="archive-row">
                <div className="archive-row__main">
                  <span className="archive-row__label">{item.label || 'Untitled session'}</span>
                  <span className="archive-row__meta">
                    {item.cwd}
                    {item.archivedAt > 0 && ` · archived ${describeAge(item.archivedAt)}`}
                  </span>
                </div>
                <div className="archive-row__actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy === item.id}
                    onClick={() => void restore(item.id)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={busy === item.id}
                    onClick={() => void remove(item)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/** "today" / "3 days ago" — enough to judge whether it is safe to delete. */
function describeAge(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
