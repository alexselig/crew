import { useEffect } from 'react'
import type { Settings } from '../../shared/types'

interface Props {
  settings: Settings | null
  onToggle: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  onClose: () => void
}

const TOGGLES: { key: keyof Settings; label: string; desc: string }[] = [
  { key: 'notifications', label: 'Notifications', desc: 'Native notification when a session starts waiting on you.' },
  { key: 'sound', label: 'Notification sound', desc: 'Play the system sound with notifications.' },
  {
    key: 'notifyOnlyWhenUnfocused',
    label: 'Only when unfocused',
    desc: 'Suppress notifications while the Crew window is focused.'
  },
  { key: 'showSpend', label: 'Show spend', desc: 'Display dollar spend per session and the total in the sidebar.' },
  {
    key: 'showCredits',
    label: 'Show credits used',
    desc: 'Display credit / AIC usage the agent reports (e.g. Copilot CLI).'
  },
  {
    key: 'resumeConversations',
    label: 'Resume conversations on launch',
    desc: 'Relaunch restored sessions with the agent’s --continue so history is kept.'
  },
  { key: 'launchAtLogin', label: 'Launch at login', desc: 'Start Crew automatically when you log in.' }
]

export function SettingsModal({ settings, onToggle, onClose }: Props): JSX.Element {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Settings</h2>
        {!settings ? (
          <div className="settings__loading">Loading…</div>
        ) : (
          <div className="settings__list">
            {TOGGLES.map((t) => (
              <button
                key={t.key}
                type="button"
                className="settings-row"
                onClick={() => onToggle(t.key, !settings[t.key])}
              >
                <span className="settings-row__text">
                  <span className="settings-row__label">{t.label}</span>
                  <span className="settings-row__desc">{t.desc}</span>
                </span>
                <span className={`switch ${settings[t.key] ? 'is-on' : ''}`} aria-hidden>
                  <span className="switch__knob" />
                </span>
              </button>
            ))}
            <div className="settings-row settings-row--static">
              <span className="settings-row__text">
                <span className="settings-row__label">Spend budget (USD)</span>
                <span className="settings-row__desc">
                  Warn in the sidebar when total spend reaches this. 0 = off.
                </span>
              </span>
              <input
                type="number"
                min="0"
                step="1"
                className="settings-num"
                value={settings.budgetUsd}
                onChange={(e) => onToggle('budgetUsd', Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          </div>
        )}
        <div className="modal__actions">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
