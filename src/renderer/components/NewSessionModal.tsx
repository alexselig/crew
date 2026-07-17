import { useEffect, useRef, useState } from 'react'
import type { Preset, CreateSessionRequest, SessionSet } from '../../shared/types'
import type { AgentStatus } from '../../shared/api'
import { SessionSetChips } from './SessionSetChips'
import { Icon } from './Icon'
import { normalizeSetNames, workspaceNames } from '../../shared/workspaces'

interface Props {
  presets: Preset[]
  homeDir: string
  /** Existing group (tag) names, offered as selectable chips. */
  groups?: string[]
  /** Workspaces to pre-select (e.g. the active workspace filter). */
  defaultSets?: string[]
  onCancel: () => void
  onCreate: (req: CreateSessionRequest) => void
}

const CUSTOM = '__custom__'

export function NewSessionModal({ presets, homeDir, groups = [], defaultSets = [], onCancel, onCreate }: Props): JSX.Element {
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? CUSTOM)
  const [cwd, setCwd] = useState<string>(homeDir)
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [label, setLabel] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [sets, setSets] = useState<SessionSet[]>([])
  const [setName, setSetName] = useState('')
  // Group (tag) the new session joins. Single-select; a typed name is created.
  const [group, setGroup] = useState('')
  const [newGroup, setNewGroup] = useState('')
  // Set-management (launch/save saved sets) lives in a collapsed Advanced area.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // Workspaces the new session will join, plus any freshly-typed names not yet
  // saved as sets. Pre-seeded with the active workspace when creating inside one.
  const [selectedSets, setSelectedSets] = useState<string[]>(() => normalizeSetNames(defaultSets))
  const [extraNames, setExtraNames] = useState<string[]>([])
  const [newWs, setNewWs] = useState('')
  // The Workspaces section starts collapsed to the default (most-recently-used)
  // pick with a "Change" button; expanding reveals the full picker + new field.
  const [wsExpanded, setWsExpanded] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.crew.detectAgents().then(setAgents)
    void window.crew.getSets().then(setSets)
  }, [])

  // Group chips: existing groups plus a freshly-typed one (so it shows selected).
  const groupChips =
    group.trim() && !groups.some((g) => g.toLowerCase() === group.trim().toLowerCase())
      ? [...groups, group.trim()]
      : groups
  const isGroup = (name: string): boolean => group.trim().toLowerCase() === name.toLowerCase()
  const addGroup = (): void => {
    const name = newGroup.trim()
    if (!name) return
    setGroup(name)
    setNewGroup('')
  }

  // All workspace names offered as membership chips: saved sets ∪ typed-new ∪ selected.
  const availableSets = workspaceNames(
    [...sets.map((s) => s.name), ...extraNames, ...selectedSets],
    []
  )
  const isSelected = (name: string): boolean =>
    selectedSets.some((s) => s.toLowerCase() === name.toLowerCase())
  const toggleSet = (name: string): void =>
    setSelectedSets((prev) =>
      prev.some((s) => s.toLowerCase() === name.toLowerCase())
        ? prev.filter((s) => s.toLowerCase() !== name.toLowerCase())
        : [...prev, name]
    )
  const addWorkspace = (): void => {
    const name = newWs.trim()
    if (!name) return
    if (!availableSets.some((s) => s.toLowerCase() === name.toLowerCase())) {
      setExtraNames((prev) => [...prev, name])
    }
    if (!isSelected(name)) setSelectedSets((prev) => [...prev, name])
    setNewWs('')
  }

  // Default the cwd once the home dir arrives (async).
  useEffect(() => {
    setCwd((cur) => cur || homeDir)
  }, [homeDir])

  useEffect(() => {
    if (presets.length && presetId === CUSTOM && presets[0]) setPresetId(presets[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.length])

  useEffect(() => {
    requestAnimationFrame(() => firstFieldRef.current?.focus())
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const isCustom = presetId === CUSTOM
  const cwdOk = cwd.trim().length > 0
  const commandOk = !isCustom || command.trim().length > 0
  const canCreate = cwdOk && commandOk

  function submit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canCreate) return
    const preset = presets.find((p) => p.id === presetId)
    const chosenSets = normalizeSetNames(selectedSets)
    const tag = group.trim() || undefined
    const req: CreateSessionRequest = isCustom
      ? {
          presetId: null,
          command: command.trim(),
          args: tokenize(args),
          cwd: cwd.trim(),
          label: label.trim() || undefined,
          initialPrompt: initialPrompt.trim() || undefined,
          tag,
          sets: chosenSets
        }
      : {
          presetId: preset!.id,
          command: preset!.command,
          args: preset!.args,
          cwd: cwd.trim(),
          label: label.trim() || undefined,
          initialPrompt: initialPrompt.trim() || undefined,
          tag,
          sets: chosenSets
        }
    onCreate(req)
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <form className="modal modal--session" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">New Session</h2>

        <label className="field">
          <span className="field__label">Label</span>
          <input
            ref={firstFieldRef}
            className="field__input"
            placeholder="Name your session"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

        <div className="sets">
          <span className="field__label">Group</span>
          <p className="modal__hint modal__hint--tight">
            Assign this session to a group (used for the group filter)
          </p>
          <div className="ws-picker">
            {groupChips.length === 0 && (
              <span className="sets__empty">No groups yet — create one below.</span>
            )}
            {groupChips.map((name) => (
              <button
                type="button"
                key={name}
                className={`ws-chip ${isGroup(name) ? 'is-on' : ''}`}
                aria-pressed={isGroup(name)}
                onClick={() => setGroup(isGroup(name) ? '' : name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="sets__save">
            <input
              className="field__input"
              placeholder="New group name…"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addGroup()
                }
              }}
            />
            <button type="button" className="btn" disabled={!newGroup.trim()} onClick={addGroup}>
              ＋ Add
            </button>
          </div>
        </div>

        <div className="sets">
          <span className="field__label">Workspaces</span>
          <p className="modal__hint modal__hint--tight">
            Add this session to one or more workspaces — switch between them from File › Change Workspace.
          </p>
          {!wsExpanded && availableSets.length > 0 ? (
            <div className="ws-picker ws-picker--current">
              {selectedSets.length > 0 ? (
                selectedSets.map((name) => (
                  <span key={name} className="ws-chip is-on ws-chip--static">
                    {name}
                  </span>
                ))
              ) : (
                <span className="sets__empty">No workspace</span>
              )}
              <button type="button" className="ws-change" onClick={() => setWsExpanded(true)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="ws-picker">
                {availableSets.length === 0 && (
                  <span className="sets__empty">No workspaces yet — add one below.</span>
                )}
                {availableSets.map((name) => (
                  <button
                    type="button"
                    key={name}
                    className={`ws-chip ${isSelected(name) ? 'is-on' : ''}`}
                    aria-pressed={isSelected(name)}
                    onClick={() => toggleSet(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
              <div className="sets__save">
                <input
                  className="field__input"
                  placeholder="New workspace name…"
                  value={newWs}
                  onChange={(e) => setNewWs(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addWorkspace()
                    }
                  }}
                />
                <button type="button" className="btn" disabled={!newWs.trim()} onClick={addWorkspace}>
                  ＋ Add
                </button>
              </div>
            </>
          )}
        </div>

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
            <option value={CUSTOM}>Custom command…</option>
          </select>
          {!isCustom &&
            (() => {
              const st = agents.find((a) => a.presetId === presetId)
              if (!st || st.available) return null
              return (
                <span className="agent-status agent-status--missing">
                  ✗ <code>{st.command}</code> not found on PATH
                  {st.installHint ? ` — ${st.installHint}` : ''}
                </span>
              )
            })()}
        </label>

        {isCustom && (
          <>
            <label className="field">
              <span className="field__label">Command</span>
              <input
                className="field__input"
                placeholder="e.g. aider"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">Arguments</span>
              <input
                className="field__input"
                placeholder="--model gpt-4o (optional)"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </label>
          </>
        )}

        <div className="advanced">
          <button
            type="button"
            className="advanced__toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <Icon name={advancedOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            Advanced
          </button>
          {advancedOpen && (
            <div className="advanced__body">
              <label className="field">
                <span className="field__label">Initial prompt (optional)</span>
                <textarea
                  className="field__input field__input--area"
                  placeholder="Sent to the agent on launch"
                  value={initialPrompt}
                  onChange={(e) => setInitialPrompt(e.target.value)}
                  rows={2}
                />
              </label>
              <label className="field">
                <span className="field__label">Working directory</span>
                <input
                  className="field__input"
                  placeholder={homeDir}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
              </label>
              <span className="field__label">Saved sets</span>
              <SessionSetChips
                sets={sets}
                emptyText="None saved yet"
                onLaunch={(name) => {
                  void window.crew.launchSet(name)
                  onCancel()
                }}
                onDelete={(name) => void window.crew.deleteSet(name).then(setSets)}
              />
              <div className="sets__save">
                <input
                  className="field__input"
                  placeholder="Save currently open sessions as…"
                  value={setName}
                  onChange={(e) => setSetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (setName.trim()) void window.crew.saveSet(setName.trim()).then(setSets)
                      setSetName('')
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!setName.trim()}
                  onClick={() => {
                    void window.crew.saveSet(setName.trim()).then(setSets)
                    setSetName('')
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={!canCreate}>
            Launch
          </button>
        </div>
      </form>
    </div>
  )
}

/** Split a shell-ish argument string, honoring simple single/double quotes. */
function tokenize(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}
