import { useState } from 'react'
import type { SessionInfo, CharacterDef, Workspace } from '../../shared/types'
import type { SessionDrag } from '../useSessionDrag'
import type { GroupHeaderDnd } from '../useGroupReorder'
import { WorkspaceSessionCard } from './WorkspaceSessionCard'

interface Props {
  /** The workspace this lane represents, or null for the Archived lane. */
  workspace: Workspace | null
  sessions: SessionInfo[]
  characters: CharacterDef[]
  workspaces: Workspace[]
  drag: SessionDrag
  /** Drag handlers to reorder lane headers (real workspaces only). */
  reorder?: GroupHeaderDnd
  onRenameWs: (id: string, name: string) => void
  onDescribeWs: (id: string, description: string) => void
  onDeleteWs: (id: string, name: string, memberCount: number) => void
  onRename: (id: string, label: string) => void
  onDescribe: (id: string, description: string) => void
  onArchive: (id: string) => void
  onDuplicate: (id: string, wsId: string | null) => void
  onMoveTo: (id: string, fromLaneId: string | null, toLaneId: string | null) => void
  onRemoveFrom: (id: string, wsId: string) => void
  onOpen: (id: string) => void
}

/**
 * A single column on the Workspace board: a header (editable title + description
 * for real workspaces, or a static "Archived" label), the sessions it holds, and
 * a drop target that accepts dragged session cards. Reorder the lane by dragging
 * its header (wired via the shared `useGroupReorder` hook).
 */
export function WorkspaceLane({
  workspace,
  sessions,
  characters,
  workspaces,
  drag,
  reorder,
  onRenameWs,
  onDescribeWs,
  onDeleteWs,
  onRename,
  onDescribe,
  onArchive,
  onDuplicate,
  onMoveTo,
  onRemoveFrom,
  onOpen
}: Props): JSX.Element {
  const laneId = workspace?.id ?? null
  const isArchived = workspace === null
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <section
      className={`workspace-lane ${isArchived ? 'workspace-lane--archived' : ''} ${
        drag.overLane === laneId ? 'is-drop-target' : ''
      }`}
      {...drag.laneHandlers(laneId)}
    >
      <header className="workspace-lane__head" {...(reorder ?? {})}>
        <div className="workspace-lane__titlebar">
          {isArchived ? (
            <span className="workspace-lane__title" title="Sessions in no workspace">
              Archived
            </span>
          ) : editingTitle ? (
            <input
              className="workspace-lane__edit"
              defaultValue={workspace.name}
              autoFocus
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) onRenameWs(workspace.id, v)
                setEditingTitle(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <button
              type="button"
              className="workspace-lane__title"
              title="Click to rename"
              onClick={() => setEditingTitle(true)}
            >
              {workspace.name}
            </button>
          )}
          <span className="workspace-lane__count">{sessions.length}</span>
          {!isArchived && (
            <div className="workspace-lane__menu">
              <button
                type="button"
                className="workspace-lane__more"
                title="Workspace actions"
                onClick={() => setMenuOpen((v) => !v)}
                onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="workspace-menu" role="menu">
                  <button type="button" className="workspace-menu__item" onMouseDown={() => { setEditingTitle(true); setMenuOpen(false) }}>
                    Rename
                  </button>
                  <button type="button" className="workspace-menu__item" onMouseDown={() => { setEditingDesc(true); setMenuOpen(false) }}>
                    {workspace.description ? 'Edit description' : 'Add description'}
                  </button>
                  <button
                    type="button"
                    className="workspace-menu__item workspace-menu__item--danger"
                    onMouseDown={() => { onDeleteWs(workspace.id, workspace.name, sessions.length); setMenuOpen(false) }}
                  >
                    Delete workspace
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {!isArchived &&
          (editingDesc ? (
            <input
              className="workspace-lane__edit workspace-lane__edit--desc"
              defaultValue={workspace.description ?? ''}
              placeholder="Describe this workspace…"
              autoFocus
              onBlur={(e) => {
                onDescribeWs(workspace.id, e.target.value)
                setEditingDesc(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditingDesc(false)
              }}
            />
          ) : workspace.description ? (
            <button type="button" className="workspace-lane__desc" onClick={() => setEditingDesc(true)}>
              {workspace.description}
            </button>
          ) : null)}
      </header>

      <div className="workspace-lane__body">
        {sessions.length === 0 ? (
          <p className="workspace-lane__empty">
            {isArchived ? 'No archived sessions.' : 'Drag a session here.'}
          </p>
        ) : (
          sessions.map((s) => (
            <WorkspaceSessionCard
              key={s.id}
              session={s}
              characters={characters}
              laneId={laneId}
              workspaces={workspaces}
              drag={drag}
              onRename={onRename}
              onDescribe={onDescribe}
              onArchive={onArchive}
              onDuplicate={onDuplicate}
              onMoveTo={onMoveTo}
              onRemoveFrom={onRemoveFrom}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  )
}
