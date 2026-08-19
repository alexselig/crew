import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, CharacterDef, Workspace } from '../../shared/types'
import { isArchived } from '../../shared/workspaces'
import { useSessionDrag, type DropIntent } from '../useSessionDrag'
import { useGroupReorder } from '../useGroupReorder'
import { LANE_SORTS, type LaneSort } from '../grouping'
import { WorkspaceLane } from './WorkspaceLane'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  workspaces: Workspace[]
  /** Focus a session in the main view (and close the manager). */
  onOpenSession: (id: string) => void
  onClose: () => void
}

/**
 * The Workspace Manager: a full-screen kanban board of workspaces (+ an Archived
 * lane) where sessions are dragged between workspaces. All state lives in main;
 * this component is controlled by the `roster`/`workspaces` props (kept fresh via
 * the roster/workspaces events in useCrew) and mutates through `window.crew.*`.
 */
export function WorkspaceManager({ roster, characters, workspaces, onOpenSession, onClose }: Props): JSX.Element {
  const [newName, setNewName] = useState('')
  // How each lane organizes the sessions inside it. Defaults to grouping by tag.
  const [sort, setSort] = useState<LaneSort>('group')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const ordered = useMemo(() => [...workspaces].sort((a, b) => a.order - b.order), [workspaces])

  // Sessions per lane, and the Archived bucket (membership in no workspace).
  const byLane = useMemo(() => {
    const map = new Map<string, SessionInfo[]>()
    for (const w of ordered) map.set(w.id, [])
    const archived: SessionInfo[] = []
    for (const s of roster) {
      if (isArchived(s.workspaceIds)) {
        archived.push(s)
        continue
      }
      for (const wsId of s.workspaceIds ?? []) map.get(wsId)?.push(s)
    }
    return { map, archived }
  }, [ordered, roster])

  const drag = useSessionDrag(
    (sessionIds: string[], fromLaneId: string | null, toLaneId: string | null, intent: DropIntent) => {
      for (const sessionId of sessionIds) {
        if (toLaneId === null) {
          void window.crew.archiveSession(sessionId)
          continue
        }
        if (intent === 'move' && fromLaneId) void window.crew.moveSessionWorkspace(sessionId, fromLaneId, toLaneId)
        else void window.crew.addSessionToWorkspace(sessionId, toLaneId)
      }
    }
  )

  const reorder = useGroupReorder(
    ordered.map((w) => w.id),
    (ids) => void window.crew.reorderWorkspaces(ids)
  )

  const createWorkspace = (): void => {
    const name = newName.trim()
    if (!name) return
    void window.crew.createWorkspace(name)
    setNewName('')
  }
  const deleteWorkspace = (id: string, name: string, memberCount: number): void => {
    if (memberCount > 0 && !window.confirm(`Delete "${name}"? Its ${memberCount} session(s) will be archived (not closed).`)) {
      return
    }
    void window.crew.deleteWorkspace(id)
  }
  const openSession = (id: string): void => {
    onOpenSession(id)
    onClose()
  }

  return (
    <div className="workspace-manager">
      <header className="workspace-manager__top">
        <span className="workspace-manager__eyebrow">Organize</span>
        <h1 className="workspace-manager__title">
          Work<em>spaces</em>
        </h1>
        <div className="workspace-manager__controls">
          <label className="workspace-manager__sort">
            <span className="workspace-manager__sort-label">Sort</span>
            <select
              className="workspace-manager__sort-select"
              value={sort}
              onChange={(e) => setSort(e.target.value as LaneSort)}
            >
              {LANE_SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <input
            className="workspace-manager__new"
            placeholder="New workspace name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createWorkspace()
            }}
          />
          <button type="button" className="workspace-manager__add" onClick={createWorkspace} disabled={!newName.trim()}>
            ＋ Add
          </button>
          <button type="button" className="workspace-manager__close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      <div className="workspace-board">
        {ordered.map((w) => (
          <WorkspaceLane
            key={w.id}
            workspace={w}
            sessions={byLane.map.get(w.id) ?? []}
            characters={characters}
            workspaces={workspaces}
            drag={drag}
            sort={sort}
            reorder={reorder.handlers(w.id)}
            onRenameWs={(id, name) => void window.crew.renameWorkspace(id, name)}
            onDescribeWs={(id, description) => void window.crew.describeWorkspace(id, description)}
            onDeleteWs={deleteWorkspace}
            onRename={(id, label) => void window.crew.rename(id, label)}
            onDescribe={(id, description) => void window.crew.setSessionDescription(id, description)}
            onArchive={(id) => void window.crew.archiveSession(id)}
            onDuplicate={(id, wsId) => void window.crew.duplicateSession(id, wsId)}
            onMoveTo={(id, fromLaneId, toLaneId) =>
              fromLaneId
                ? void window.crew.moveSessionWorkspace(id, fromLaneId, toLaneId as string)
                : void window.crew.addSessionToWorkspace(id, toLaneId as string)
            }
            onRemoveFrom={(id, wsId) => void window.crew.removeSessionFromWorkspace(id, wsId)}
            onOpen={openSession}
          />
        ))}

        <WorkspaceLane
          workspace={null}
          sessions={byLane.archived}
          characters={characters}
          workspaces={workspaces}
          drag={drag}
          sort={sort}
          onRenameWs={() => {}}
          onDescribeWs={() => {}}
          onDeleteWs={() => {}}
          onRename={(id, label) => void window.crew.rename(id, label)}
          onDescribe={(id, description) => void window.crew.setSessionDescription(id, description)}
          onArchive={(id) => void window.crew.archiveSession(id)}
          onDuplicate={(id, wsId) => void window.crew.duplicateSession(id, wsId)}
          onMoveTo={(id, fromLaneId, toLaneId) =>
            fromLaneId
              ? void window.crew.moveSessionWorkspace(id, fromLaneId, toLaneId as string)
              : void window.crew.addSessionToWorkspace(id, toLaneId as string)
          }
          onRemoveFrom={(id, wsId) => void window.crew.removeSessionFromWorkspace(id, wsId)}
          onOpen={openSession}
        />
      </div>
    </div>
  )
}
