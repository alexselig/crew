import { useEffect, useRef, useState } from 'react'
import type { Preset, CreateSessionRequest } from '../../shared/types'

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
  const firstFieldRef = useRef<HTMLSelectElement>(null)

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

        <label className="field">
          <span className="field__label">Agent</span>
          <select
            ref={firstFieldRef}
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
