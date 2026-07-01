import { useEffect, useState } from 'react'
import type { SessionInfo } from '../../shared/types'
import type { TranscriptMatch } from '../../shared/api'

interface Props {
  roster: SessionInfo[]
  selectedId: string | null
  onClose: () => void
}

export function TranscriptsModal({ roster, selectedId, onClose }: Props): JSX.Element {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<TranscriptMatch[]>([])
  const [note, setNote] = useState('')

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim()) void window.crew.searchTranscripts(q).then(setResults)
      else setResults([])
    }, 200)
    return () => clearTimeout(t)
  }, [q])

  const labelOf = (id: string): string => roster.find((s) => s.id === id)?.label ?? id.slice(0, 6)
  const selected = roster.find((s) => s.id === selectedId) ?? null

  async function exportSelected(): Promise<void> {
    if (!selected) return
    const done = await window.crew.exportTranscript(selected.id, selected.label)
    setNote(done ? 'Exported ✓' : 'Export canceled')
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Transcripts</h2>
        <p className="modal__hint">
          Search saved session output. Enable “Capture transcripts” in Settings to record.
        </p>
        <input
          className="field__input"
          placeholder="Search transcripts…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="transcript-results">
          {q.trim() === '' ? (
            <div className="muted">Type to search.</div>
          ) : results.length === 0 ? (
            <div className="muted">No matches.</div>
          ) : (
            results.map((r, i) => (
              <div key={i} className="transcript-row">
                <span className="transcript-sess">{labelOf(r.sessionId)}</span>
                <span className="transcript-line">{r.line}</span>
              </div>
            ))
          )}
        </div>
        <div className="modal__actions">
          {selected && (
            <button type="button" className="btn" onClick={() => void exportSelected()}>
              Export “{selected.label}”…
            </button>
          )}
          {note && <span className="transcript-note">{note}</span>}
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
