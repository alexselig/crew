import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, CharacterDef, Workspace } from '../../shared/types'
import { Character } from './Character'
import { StatusTag } from './StatusTag'
import type { SessionDrag } from '../useSessionDrag'

interface Props {
  session: SessionInfo
  characters: CharacterDef[]
  /** The lane this card is rendered in (null = Archived). */
  laneId: string | null
  workspaces: Workspace[]
  drag: SessionDrag
  onRename: (id: string, label: string) => void
  onDescribe: (id: string, description: string) => void
  onArchive: (id: string) => void
  onDuplicate: (id: string, wsId: string | null) => void
  onMoveTo: (id: string, fromLaneId: string | null, toLaneId: string | null) => void
  onRemoveFrom: (id: string, wsId: string) => void
  onOpen: (id: string) => void
}

/**
 * A draggable session on the Workspace board: mascot + status, inline-editable
 * name and description, and a ⋯ menu (open, move, duplicate, archive/remove).
 * Dragging is wired by the shared `useSessionDrag` hook.
 */
export function WorkspaceSessionCard({
  session,
  characters,
  laneId,
  workspaces,
  drag,
  onRename,
  onDescribe,
  onArchive,
  onDuplicate,
  onMoveTo,
  onRemoveFrom,
  onOpen
}: Props): JSX.Element {
  const char = characters.find((c) => c.id === session.characterId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  const others = workspaces.filter((w) => w.id !== laneId)

  return (
    <div
      className={`workspace-card ${drag.draggingIds.includes(session.id) ? 'is-dragging' : ''}`}
      {...drag.cardHandlers(session.id, laneId)}
    >
      <span className="workspace-card__glyph">
        <Character
          glyph={char?.glyph ?? '●'}
          id={session.characterId}
          color={session.color}
          state={session.state}
          size={30}
          dot={false}
          badge={false}
        />
      </span>

      <div className="workspace-card__body">
        {editingName ? (
          <input
            className="workspace-card__edit"
            defaultValue={session.label}
            autoFocus
            onBlur={(e) => {
              onRename(session.id, e.target.value.trim() || session.label)
              setEditingName(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingName(false)
            }}
          />
        ) : (
          <button
            type="button"
            className="workspace-card__name"
            title="Click to rename"
            onClick={() => setEditingName(true)}
          >
            {session.label}
          </button>
        )}

        {editingDesc ? (
          <input
            className="workspace-card__edit workspace-card__edit--desc"
            defaultValue={session.description ?? ''}
            placeholder="Add a description…"
            autoFocus
            onBlur={(e) => {
              onDescribe(session.id, e.target.value)
              setEditingDesc(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingDesc(false)
            }}
          />
        ) : (
          <button
            type="button"
            className={`workspace-card__desc ${session.description ? '' : 'is-empty'}`}
            title="Click to edit description"
            onClick={() => setEditingDesc(true)}
          >
            {session.description || 'Add a description…'}
          </button>
        )}
      </div>

      <StatusTag state={session.state} variant="chip" className="workspace-card__status" />

      <div className="workspace-card__menu" ref={menuRef}>
        <button
          type="button"
          className="workspace-card__more"
          title="More…"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="workspace-menu" role="menu">
            <button type="button" className="workspace-menu__item" onClick={() => { onOpen(session.id); setMenuOpen(false) }}>
              Open
            </button>
            {laneId !== null && (
              <button
                type="button"
                className="workspace-menu__item"
                onClick={() => { onRemoveFrom(session.id, laneId); setMenuOpen(false) }}
              >
                Remove from this workspace
              </button>
            )}
            <button
              type="button"
              className="workspace-menu__item"
              onClick={() => { onArchive(session.id); setMenuOpen(false) }}
            >
              Archive
            </button>
            {others.length > 0 && <div className="workspace-menu__label">Move to</div>}
            {others.map((w) => (
              <button
                key={'mv-' + w.id}
                type="button"
                className="workspace-menu__item"
                onClick={() => { onMoveTo(session.id, laneId, w.id); setMenuOpen(false) }}
              >
                {w.name}
              </button>
            ))}
            <div className="workspace-menu__label">Duplicate as new session</div>
            <button
              type="button"
              className="workspace-menu__item"
              onClick={() => { onDuplicate(session.id, laneId); setMenuOpen(false) }}
            >
              {laneId === null ? 'No workspace' : 'This workspace'}
            </button>
            {others.map((w) => (
              <button
                key={'dup-' + w.id}
                type="button"
                className="workspace-menu__item"
                onClick={() => { onDuplicate(session.id, w.id); setMenuOpen(false) }}
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
