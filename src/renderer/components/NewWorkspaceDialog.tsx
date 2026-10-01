import { useEffect, useRef, useState } from 'react'
import type { Preset, Workspace } from '../../shared/types'
import { workspaceNameAvailable } from '../../shared/workspaces'
import type { NewWorkspaceChoice } from '../../shared/conductor-entry'

export type { NewWorkspaceChoice }

interface Props {
  /** The name already typed in the manager's field; the dialog opens on it
   *  and lets it be corrected, because a name main refuses is the one case
   *  where everything else typed here would otherwise be thrown away. */
  name: string
  presets: Preset[]
  /** Existing workspaces, read only to tell the user a name is taken before
   *  they have filled in the rest of the form. */
  workspaces: Workspace[]
  homeDir: string
  /** Why the last attempt failed, e.g. a name another window took first.
   *  Shown here, with the form still filled in. */
  error: string | null
  onCreate: (choice: NewWorkspaceChoice) => void
  onCancel: () => void
}

/**
 * Asks the one question that has to be answered when a workspace is born:
 * is it a standard workspace, or a conducted one?
 *
 * It is asked here, at creation, because it is a question about the workspace
 * rather than about anything in it, and because the alternative was worse:
 * the conductor panel used to offer "New conducted workspace…" from inside
 * whatever workspace you were looking at, which put conductor UI in front of
 * people who had no conductor and made "which workspace does this belong to"
 * genuinely ambiguous.
 *
 * Choosing conducted asks for two more things, both of which a conductor
 * cannot start without: where the repository is, and what the user actually
 * wants done. The starting prompt is not a nicety — a conductor session with
 * no brief has nothing to plan, so the create button stays disabled until
 * there is one.
 */
export function NewWorkspaceDialog({
  name,
  presets,
  workspaces,
  homeDir,
  error,
  onCreate,
  onCancel
}: Props): JSX.Element {
  const [chosenName, setChosenName] = useState(name)
  const [conducted, setConducted] = useState(false)
  const [presetId, setPresetId] = useState(presets[0]?.id ?? '')
  const [cwd, setCwd] = useState(homeDir)
  const [prompt, setPrompt] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  // Moving to the conducted arm puts the cursor in the brief, which is the
  // field the user came here to fill in.
  useEffect(() => {
    if (conducted) requestAnimationFrame(() => promptRef.current?.focus())
  }, [conducted])

  // The same rule main creates by, so a name it will refuse is refused here
  // while the user can still change it instead of losing the form.
  const nameOk = workspaceNameAvailable(workspaces, chosenName)
  // A conducted workspace needs somewhere to run and something to do. A
  // standard one needs neither, so it is never blocked by them.
  const ready =
    nameOk && (!conducted || (cwd.trim().length > 0 && prompt.trim().length > 0 && presetId !== ''))

  const submit = (): void => {
    if (!ready) return
    onCreate({
      name: chosenName.trim(),
      conducted,
      presetId,
      cwd: cwd.trim() || homeDir,
      prompt: prompt.trim()
    })
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="New workspace">
      <div className="modal new-workspace">
        <h2 className="new-workspace__title">New workspace</h2>

        <label className="field">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            aria-label="Workspace name"
            value={chosenName}
            onChange={(e) => setChosenName(e.target.value)}
          />
        </label>
        {chosenName.trim() !== '' && !nameOk && (
          <p className="conductor-composer-error new-workspace__error">
            A workspace called “{chosenName.trim()}” already exists.
          </p>
        )}

        <div className="new-workspace__kinds">
          <button
            type="button"
            className={conducted ? 'new-workspace__kind' : 'new-workspace__kind is-chosen'}
            aria-pressed={!conducted}
            onClick={() => setConducted(false)}
          >
            <span className="new-workspace__kind-name">Standard</span>
            <span className="new-workspace__kind-blurb">
              A place to keep sessions. You start and arrange them yourself.
            </span>
          </button>
          <button
            type="button"
            className={conducted ? 'new-workspace__kind is-chosen' : 'new-workspace__kind'}
            aria-pressed={conducted}
            onClick={() => setConducted(true)}
          >
            <span className="new-workspace__kind-name">Conducted</span>
            <span className="new-workspace__kind-blurb">
              Starts with a conductor session that reads the repository, plans the work, and
              proposes which agents should run it.
            </span>
          </button>
        </div>

        {conducted && (
          <>
            <label className="field">
              <span className="field__label">Agent</span>
              <select
                className="field__input"
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Repository</span>
              <input
                className="field__input"
                aria-label="Repository"
                placeholder={homeDir}
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">What should the conductor work on?</span>
              <textarea
                ref={promptRef}
                className="field__input new-workspace__prompt"
                aria-label="What should the conductor work on?"
                rows={4}
                placeholder="e.g. Add OAuth sign-in, with tests, and split the work across agents."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          </>
        )}

        {error && <p className="conductor-composer-error new-workspace__error">{error}</p>}

        <div className="new-workspace__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready} onClick={submit}>
            {conducted ? 'Create and start conducting' : 'Create workspace'}
          </button>
        </div>
      </div>
    </div>
  )
}
