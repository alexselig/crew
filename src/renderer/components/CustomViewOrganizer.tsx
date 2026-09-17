import { useEffect, useMemo, useRef, useState } from 'react'
import { searchCustomViewSessions } from '../../shared/custom-views'
import type {
  CustomView,
  CustomViewItem,
  CustomViewMode,
  Preset,
  SessionInfo,
  SessionStatus,
  Workspace
} from '../../shared/types'
import { reduceOrganizer, type OrganizerAction } from '../custom-view-dnd'

interface Props {
  view: CustomView | null
  editing?: boolean
  roster: SessionInfo[]
  workspaces: Workspace[]
  presets: Preset[]
  restoreFocusTo?: HTMLElement | null
  onSaved: (saved: CustomView, views: CustomView[]) => void
  onDeleted: (views: CustomView[]) => void
  onClose: () => void
}

interface DragPayload {
  source: 'available' | 'ranked'
  sessionId: string
}

const DRAG_MIME = 'application/x-crew-custom-view-session'
const NO_PRESET = '__no-preset__'
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function readDragPayload(event: React.DragEvent): DragPayload | null {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData(DRAG_MIME)) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('source' in parsed) ||
      (parsed.source !== 'available' && parsed.source !== 'ranked') ||
      !('sessionId' in parsed) ||
      typeof parsed.sessionId !== 'string'
    ) {
      return null
    }
    return { source: parsed.source, sessionId: parsed.sessionId }
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CustomViewOrganizer({
  view,
  editing = view !== null,
  roster,
  workspaces,
  presets,
  restoreFocusTo = null,
  onSaved,
  onDeleted,
  onClose
}: Props): JSX.Element {
  const [name, setName] = useState(view?.name ?? '')
  const [mode, setMode] = useState<CustomViewMode>(view?.mode ?? 'ranked-plus-all')
  const [items, setItems] = useState<CustomViewItem[]>(() =>
    view?.items.map((item) => ({ ...item })) ?? []
  )
  const [query, setQuery] = useState('')
  const [workspaceId, setWorkspaceId] = useState('all')
  const [status, setStatus] = useState<SessionStatus | 'all'>('all')
  const [presetId, setPresetId] = useState('all')
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [removalTarget, setRemovalTarget] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(
    restoreFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
  )
  const conflict = editing && view === null

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (conflict) closeRef.current?.focus()
      else nameRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [conflict])

  useEffect(() => {
    if (saving) dialogRef.current?.focus()
  }, [saving])

  useEffect(() => {
    function containFocus(event: FocusEvent): void {
      const dialog = dialogRef.current
      if (!dialog || dialog.contains(event.target as Node)) return
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE)
      if (first) first.focus()
      else dialog.focus()
    }
    document.addEventListener('focusin', containFocus)
    return () => document.removeEventListener('focusin', containFocus)
  }, [])

  useEffect(
    () => () => {
      const opener = restoreFocusRef.current
      if (opener?.isConnected) opener.focus()
    },
    []
  )

  const presetNames = useMemo(() => {
    const names = new Map<string | null, string>(presets.map((preset) => [preset.id, preset.name]))
    names.set(null, 'No preset')
    return names
  }, [presets])

  const visibleSessions = useMemo(
    () =>
      searchCustomViewSessions({
        sessions: roster,
        query,
        workspaces,
        presetNames,
        workspaceId: workspaceId === 'all' ? undefined : workspaceId,
        status,
        presetId: presetId === NO_PRESET ? null : presetId
      }),
    [presetId, presetNames, query, roster, status, workspaceId, workspaces]
  )

  const rosterById = useMemo(
    () => new Map(roster.map((session) => [session.id, session] as const)),
    [roster]
  )
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name] as const)),
    [workspaces]
  )
  const rankedIds = useMemo(() => new Set(items.map((item) => item.sessionId)), [items])

  function dispatch(action: OrganizerAction): void {
    if (saving || conflict) return
    setItems((current) => reduceOrganizer(current, action))
  }

  function startDrag(
    event: React.DragEvent<HTMLElement>,
    payload: DragPayload
  ): void {
    if (saving || conflict) {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
    event.dataTransfer.effectAllowed = payload.source === 'available' ? 'copyMove' : 'move'
    setDragging(payload)
    setError(null)
  }

  function finishDrag(): void {
    setDragging(null)
    setDropIndex(null)
    setRemovalTarget(false)
  }

  function dropAt(event: React.DragEvent, index: number): void {
    event.preventDefault()
    event.stopPropagation()
    if (saving || conflict) return finishDrag()
    const payload = readDragPayload(event)
    if (!payload) return finishDrag()

    if (payload.source === 'available') {
      const session = rosterById.get(payload.sessionId)
      if (session) dispatch({ type: 'insert', session, index })
    } else {
      dispatch({ type: 'move', sessionId: payload.sessionId, index })
    }
    finishDrag()
  }

  function dropOnAvailable(event: React.DragEvent): void {
    event.preventDefault()
    if (saving || conflict) return finishDrag()
    const payload = readDragPayload(event)
    if (payload?.source === 'ranked') {
      dispatch({ type: 'remove', sessionId: payload.sessionId })
    }
    finishDrag()
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (saving || conflict) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Enter a name for this view.')
      nameRef.current?.focus()
      return
    }

    setSaving(true)
    setError(null)
    try {
      const input = { name: trimmedName, mode, items }
      if (view) {
        const views = await window.crew.updateCustomView(view.id, input)
        const saved = views.find((item) => item.id === view.id)
        if (!saved) throw new Error('The saved custom view is no longer available.')
        onSaved(saved, views)
      } else {
        const result = await window.crew.createCustomView(input)
        onSaved(result.created, result.views)
      }
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  async function deleteView(): Promise<void> {
    if (!view || saving || conflict) return
    if (!window.confirm(`Delete "${view.name}"? Sessions in this view will not be changed.`)) return

    setSaving(true)
    setError(null)
    try {
      onDeleted(await window.crew.deleteCustomView(view.id))
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        event.currentTarget.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    event.stopPropagation()
  }

  return (
    <div className="modal-overlay" onMouseDown={saving ? undefined : onClose}>
      <form
        ref={dialogRef}
        className="modal modal--wide custom-view-organizer"
        role="dialog"
        aria-modal="true"
        aria-busy={saving}
        tabIndex={-1}
        aria-labelledby="custom-view-organizer-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        onSubmit={save}
      >
        <div className="custom-view-organizer__header">
          <div>
            <span className="custom-view-organizer__eyebrow">
              {editing ? 'Edit custom view' : 'New custom view'}
            </span>
            <h2 className="modal__title" id="custom-view-organizer-title">
              {conflict ? 'View unavailable' : 'Organize sessions'}
            </h2>
          </div>
        </div>

        {conflict ? (
          <>
            <div className="custom-view-organizer__conflict" role="alert">
              This custom view was deleted in another window. Your local draft was not saved,
              and Crew will not recreate the deleted view.
            </div>
            <div className="modal__actions custom-view-organizer__actions">
              <div className="custom-view-organizer__actions-main">
                <button ref={closeRef} type="button" className="btn btn--primary" onClick={onClose}>
                  Close
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
        <div className="custom-view-organizer__settings">
          <label className="field">
            <span className="field__label">Name</span>
            <input
              ref={nameRef}
              className="field__input"
              aria-label="View name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </label>
          <label className="field">
            <span className="field__label">Display mode</span>
            <select
              className="field__input"
              aria-label="Display mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as CustomViewMode)}
              disabled={saving}
            >
              <option value="ranked-plus-all">Ranked first, then all sessions</option>
              <option value="curated-only">Ranked sessions only</option>
            </select>
          </label>
        </div>

        <div className="custom-view-organizer__columns">
          <section
            className={`custom-view-organizer__column custom-view-organizer__available-drop ${
              removalTarget ? 'is-remove-target' : ''
            }`}
            aria-labelledby="custom-view-all-title"
            onDragOver={(event) => {
              if (saving || dragging?.source !== 'ranked') return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setRemovalTarget(true)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setRemovalTarget(false)
              }
            }}
            onDrop={dropOnAvailable}
          >
            <div className="custom-view-organizer__column-head">
              <div>
                <h3 id="custom-view-all-title">All sessions</h3>
                <span>{visibleSessions.length} shown</span>
              </div>
              {dragging?.source === 'ranked' && (
                <span className="custom-view-organizer__remove-hint">Drop here to remove</span>
              )}
            </div>
            <div className="custom-view-organizer__filters">
              <label className="custom-view-organizer__search">
                <input
                  type="search"
                  aria-label="Search all sessions"
                  placeholder="Search sessions..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  disabled={saving}
                />
              </label>
              <div className="custom-view-organizer__filter-row">
                <label>
                  <select
                    aria-label="Workspace filter"
                    value={workspaceId}
                    onChange={(event) => setWorkspaceId(event.target.value)}
                    disabled={saving}
                  >
                    <option value="all">All workspaces</option>
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <select
                    aria-label="Status filter"
                    value={status}
                    onChange={(event) => setStatus(event.target.value as SessionStatus | 'all')}
                    disabled={saving}
                  >
                    <option value="all">All statuses</option>
                    <option value="active">Active</option>
                    <option value="exited">Exited</option>
                    <option value="error">Error</option>
                  </select>
                </label>
                <label>
                  <select
                    aria-label="Preset filter"
                    value={presetId}
                    onChange={(event) => setPresetId(event.target.value)}
                    disabled={saving}
                  >
                    <option value="all">All agents</option>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                    <option value={NO_PRESET}>No preset</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="custom-view-organizer__list">
              {visibleSessions.map((session) => {
                const workspaceNames = (session.workspaceIds ?? [])
                  .map((id) => workspaceById.get(id))
                  .filter((value): value is string => !!value)
                  .join(', ')
                const isRanked = rankedIds.has(session.id)
                return (
                  <article
                    className={`custom-view-organizer__card custom-view-organizer__available-card ${
                      isRanked ? 'is-ranked' : ''
                    } ${dragging?.sessionId === session.id ? 'is-dragging' : ''}`}
                    data-session-id={session.id}
                    key={session.id}
                  >
                    <span
                      className="custom-view-organizer__drag"
                      data-drag-handle
                      title={`Drag ${session.label} to ranked order`}
                      aria-hidden="true"
                      draggable={!saving}
                      onDragStart={(event) =>
                        startDrag(event, { source: 'available', sessionId: session.id })
                      }
                      onDragEnd={finishDrag}
                    >
                      ::
                    </span>
                    <div className="custom-view-organizer__card-body">
                      <strong>{session.label}</strong>
                      <span>{session.cwd}</span>
                      <span>
                        {presetNames.get(session.presetId) ?? 'Unknown preset'}
                        {workspaceNames ? ` / ${workspaceNames}` : ''}
                      </span>
                    </div>
                    <div className="custom-view-organizer__card-actions">
                      {isRanked && <span className="custom-view-organizer__ranked-mark">Ranked</span>}
                      <button
                        type="button"
                        className="mini-btn"
                        aria-label={`Add ${session.label} to ranked order`}
                        disabled={saving || isRanked}
                        onClick={() => dispatch({ type: 'insert', session, index: items.length })}
                      >
                        Add
                      </button>
                    </div>
                  </article>
                )
              })}
              {visibleSessions.length === 0 && (
                <div className="custom-view-organizer__empty">No sessions match these filters.</div>
              )}
            </div>
          </section>

          <section
            className="custom-view-organizer__column"
            aria-labelledby="custom-view-ranked-title"
          >
            <div className="custom-view-organizer__column-head">
              <div>
                <h3 id="custom-view-ranked-title">Ranked order</h3>
                <span>{items.length} ranked</span>
              </div>
            </div>
            <div className="custom-view-organizer__list custom-view-organizer__ranked-list">
              {items.map((item, index) => {
                const session = rosterById.get(item.sessionId)
                const label = session?.label ?? item.labelSnapshot
                return (
                  <div className="custom-view-organizer__ranked-row" key={item.sessionId}>
                    <div
                      className={`custom-view-organizer__drop-line ${
                        dropIndex === index ? 'is-active' : ''
                      }`}
                      data-index={index}
                      onDragOver={(event) => {
                        if (saving) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setDropIndex(index)
                      }}
                      onDragLeave={() => setDropIndex((current) => (current === index ? null : current))}
                      onDrop={(event) => dropAt(event, index)}
                    />
                    <article
                      className={`custom-view-organizer__card custom-view-organizer__ranked-card ${
                        session ? '' : 'is-unavailable'
                      } ${dragging?.sessionId === item.sessionId ? 'is-dragging' : ''}`}
                      data-session-id={item.sessionId}
                    >
                      <span className="custom-view-organizer__rank">{index + 1}</span>
                      <span
                        className="custom-view-organizer__drag"
                        data-drag-handle
                        title={`Drag ${label} in ranked order`}
                        aria-hidden="true"
                        draggable={!saving}
                        onDragStart={(event) =>
                          startDrag(event, { source: 'ranked', sessionId: item.sessionId })
                        }
                        onDragEnd={finishDrag}
                      >
                        ::
                      </span>
                      <div className="custom-view-organizer__card-body">
                        <strong>{label}</strong>
                        <span>{session?.cwd ?? item.sessionId}</span>
                        {!session && <span className="custom-view-organizer__unavailable">Unavailable</span>}
                      </div>
                      <div className="custom-view-organizer__rank-actions">
                        <button
                          type="button"
                          aria-label={`Move ${label} to first`}
                          disabled={saving || index === 0}
                          onClick={() => dispatch({ type: 'move-first', sessionId: item.sessionId })}
                        >
                          First
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${label} up`}
                          disabled={saving || index === 0}
                          onClick={() => dispatch({ type: 'move-up', sessionId: item.sessionId })}
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${label} down`}
                          disabled={saving || index === items.length - 1}
                          onClick={() => dispatch({ type: 'move-down', sessionId: item.sessionId })}
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${label} to last`}
                          disabled={saving || index === items.length - 1}
                          onClick={() => dispatch({ type: 'move-last', sessionId: item.sessionId })}
                        >
                          Last
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${label} from ranked order`}
                          disabled={saving}
                          onClick={() => dispatch({ type: 'remove', sessionId: item.sessionId })}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  </div>
                )
              })}
              <div
                className={`custom-view-organizer__drop-line custom-view-organizer__drop-line--last ${
                  dropIndex === items.length ? 'is-active' : ''
                }`}
                data-index={items.length}
                onDragOver={(event) => {
                  if (saving) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDropIndex(items.length)
                }}
                onDragLeave={() =>
                  setDropIndex((current) => (current === items.length ? null : current))
                }
                onDrop={(event) => dropAt(event, items.length)}
              />
              {items.length === 0 && (
                <div className="custom-view-organizer__empty custom-view-organizer__empty--ranked">
                  Drag sessions here or use Add.
                </div>
              )}
            </div>
          </section>
        </div>

        {error && (
          <div className="custom-view-organizer__error" role="alert">
            {error}
          </div>
        )}

        <div className="modal__actions custom-view-organizer__actions">
          {view && (
            <button
              type="button"
              className="btn btn--danger"
              disabled={saving}
              onClick={() => void deleteView()}
            >
              Delete view
            </button>
          )}
          <div className="custom-view-organizer__actions-main">
            <button type="button" className="btn" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving...' : 'Save view'}
            </button>
          </div>
        </div>
          </>
        )}
      </form>
    </div>
  )
}
