import { useEffect, useMemo, useState } from 'react'
import type { SessionInfo, CharacterDef, Workspace, Preset } from '../../shared/types'
import { isArchived, workspaceNameAvailable } from '../../shared/workspaces'
import { planNewWorkspace } from '../../shared/conductor-entry'
import { useSessionDrag, type DropIntent } from '../useSessionDrag'
import { useGroupReorder } from '../useGroupReorder'
import { LANE_SORTS, type LaneSort } from '../grouping'
import { WorkspaceLane } from './WorkspaceLane'
import { NewWorkspaceDialog, type NewWorkspaceChoice } from './NewWorkspaceDialog'

interface Props {
  roster: SessionInfo[]
  characters: CharacterDef[]
  workspaces: Workspace[]
  /** Agents a conducted workspace's conductor can be run as. */
  presets: Preset[]
  /** Default working directory offered for a conducted workspace. */
  homeDir: string
  /** Focus a session in the main view (and close the manager). */
  onOpenSession: (id: string) => void
  /** Set the workspace filter. A workspace just created is made active this
   *  way rather than through onOpenSession, which only ever CLEARS the
   *  filter and so would leave a new conducted workspace unselected. */
  onActivateWorkspace: (id: string | null) => void
  /** Select a session by id, without looking it up in the roster: a session
   *  created a moment ago may not have reached the roster broadcast yet. */
  onSelectSession: (id: string) => void
  onClose: () => void
}

/**
 * The Workspace Manager: a full-screen kanban board of workspaces (+ an Archived
 * lane) where sessions are dragged between workspaces. All state lives in main;
 * this component is controlled by the `roster`/`workspaces` props (kept fresh via
 * the roster/workspaces events in useCrew) and mutates through `window.crew.*`.
 */
export function WorkspaceManager({
  roster,
  characters,
  workspaces,
  presets,
  homeDir,
  onOpenSession,
  onActivateWorkspace,
  onSelectSession,
  onClose
}: Props): JSX.Element {
  const [newName, setNewName] = useState('')
  // The name being confirmed in the new-workspace dialog, or null when it is
  // closed. Held separately from `newName` so the field can be cleared the
  // moment the dialog opens without the dialog losing the name it is for.
  const [pendingName, setPendingName] = useState<string | null>(null)
  // Why the last create attempt went nowhere. Shown in the dialog while it is
  // open (so nothing typed is lost) and in the header once it has closed.
  const [createError, setCreateError] = useState<string | null>(null)
  // How each lane organizes the sessions inside it. Defaults to grouping by tag.
  const [sort, setSort] = useState<LaneSort>('group')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // While the new-workspace dialog is up it owns Escape. Both listen on
      // document, so without this one keypress would dismiss the dialog and
      // the whole manager behind it.
      if (e.key === 'Escape' && pendingName === null) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, pendingName])

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

  // "Add" no longer creates anything on its own: it opens the dialog that
  // asks what KIND of workspace this is. The name is captured here so the
  // field can be emptied immediately.
  const beginCreate = (): void => {
    const name = newName.trim()
    if (!name) return
    // Checked before the dialog opens, by the same rule main creates with: a
    // name main will refuse must not be discovered after a repository path
    // and a brief have been typed against it.
    if (!workspaceNameAvailable(workspaces, name)) {
      setCreateError(`A workspace called “${name}” already exists.`)
      return
    }
    setCreateError(null)
    setPendingName(name)
    setNewName('')
  }

  const finishCreate = async (choice: NewWorkspaceChoice): Promise<void> => {
    setCreateError(null)
    const created = await window.crew.createWorkspace(choice.name, { conducted: choice.conducted })
    // Null means a blank or duplicate name, which main rejects. The dialog
    // stays open on everything already typed, so the user changes the name
    // rather than filling the form in again.
    if (!created) {
      setCreateError(`A workspace called “${choice.name}” already exists.`)
      return
    }
    const plan = planNewWorkspace(created, choice, presets)
    setPendingName(null)
    // A conducted workspace whose conductor could not be built still exists,
    // as a workspace with no sessions. That is recoverable by hand; silently
    // launching the wrong agent in it would not be.
    if (!plan) {
      setCreateError(`“${created.name}” was created, but its conductor could not be started — ` +
        'check the agent and repository and start it by hand.')
      return
    }
    if (plan.activateWorkspaceId !== null) onActivateWorkspace(plan.activateWorkspaceId)
    if (!plan.session) return
    try {
      const session = await window.crew.createSession(plan.session)
      // Straight into the conductor, which is the whole point of choosing
      // conducted: the user asked for work to start, not for a folder. The id
      // comes from the session just created, never from the roster, which the
      // creating window has not been told about yet.
      onSelectSession(session.id)
      onClose()
    } catch (error) {
      setCreateError(`“${created.name}” was created, but its conductor did not start: ` +
        `${error instanceof Error ? error.message : String(error)}`)
    }
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
              if (e.key === 'Enter') beginCreate()
            }}
          />
          <button type="button" className="workspace-manager__add" onClick={beginCreate} disabled={!newName.trim()}>
            ＋ Add
          </button>
          <button type="button" className="workspace-manager__close" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>
        {pendingName === null && createError && (
          <p className="conductor-composer-error workspace-manager__error">{createError}</p>
        )}
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

      {pendingName !== null && (
        <NewWorkspaceDialog
          name={pendingName}
          presets={presets}
          workspaces={workspaces}
          homeDir={homeDir}
          error={createError}
          onCreate={(choice) => {
            // Nothing else observes this promise, so a rejection that escaped
            // finishCreate's own handling would otherwise be an unhandled
            // rejection the user never hears about.
            void finishCreate(choice).catch((error: unknown) => {
              setCreateError(
                `Could not create that workspace: ${error instanceof Error ? error.message : String(error)}`
              )
            })
          }}
          onCancel={() => {
            setPendingName(null)
            setCreateError(null)
          }}
        />
      )}
    </div>
  )
}
