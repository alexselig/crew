import { useEffect, useRef, useState } from 'react'
import type { Preset, CreateSessionRequest, SessionSet } from '../../shared/types'
import type { AgentStatus } from '../../shared/api'
import { SessionSetChips } from './SessionSetChips'

interface Props {
  presets: Preset[]
  homeDir: string
  onCancel: () => void
  onCreate: (req: CreateSessionRequest) => void
}

const CUSTOM = '__custom__'

export function NewSessionModal({ presets, homeDir, onCancel, onCreate }: Props): JSX.Element {
  const [presetId, setPresetId] = useState<string>(presets[0]?.id ?? CUSTOM)
  const [cwd, setCwd] = useState<string>(homeDir)
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [label, setLabel] = useState('')
  const [initialPrompt, setInitialPrompt] = useState('')
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [sets, setSets] = useState<SessionSet[]>([])
  const [setName, setSetName] = useState('')
  const firstFieldRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    void window.crew.detectAgents().then(setAgents)
    void window.crew.getSets().then(setSets)
  }, [])

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
    const req: CreateSessionRequest = isCustom
      ? {
          presetId: null,
          command: command.trim(),
          args: tokenize(args),
          cwd: cwd.trim(),
          label: label.trim() || undefined,
          initialPrompt: initialPrompt.trim() || undefined
        }
      : {
          presetId: preset!.id,
          command: preset!.command,
          args: preset!.args,
          cwd: cwd.trim(),
          label: label.trim() || undefined,
          initialPrompt: initialPrompt.trim() || undefined
        }
    onCreate(req)
  }

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal__title">New Session</h2>

        <div className="sets">
          <span className="field__label">Project sets</span>
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

        <label className="field">
          <span className="field__label">Agent</span>
          <select
            ref={firstFieldRef}
            className="field__input"
            value={presetId}
            onChange={(e) => setPresetId(e.target.value)}
          >
            {presets.map((p) => {
              const st = agents.find((a) => a.presetId === p.id)
              const mark = st ? (st.available ? '✓ ' : '✗ ') : ''
              return (
                <option key={p.id} value={p.id}>
                  {mark}
                  {p.name}
                </option>
              )
            })}
            <option value={CUSTOM}>Custom command…</option>
          </select>
          {!isCustom &&
            (() => {
              const st = agents.find((a) => a.presetId === presetId)
              if (!st) return null
              return st.available ? (
                <span className="agent-status agent-status--ok" title={st.path ?? ''}>
                  ✓ Installed{st.path ? ` · ${st.path}` : ''}
                </span>
              ) : (
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

        <label className="field">
          <span className="field__label">Working directory</span>
          <input
            className="field__input"
            placeholder={homeDir}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Label (optional)</span>
          <input
            className="field__input"
            placeholder="auto from folder + agent"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>

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
