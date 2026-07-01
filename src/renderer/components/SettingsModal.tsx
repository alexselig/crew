import { useEffect, useState } from 'react'
import type { Settings } from '../../shared/types'

interface Props {
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
  { key: 'launchAtLogin', label: 'Launch at login', desc: 'Start Crew automatically when you log in.' }
]

export function SettingsModal({ onClose }: Props): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    void window.crew.getSettings().then(setSettings)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function toggle(key: keyof Settings): Promise<void> {
    if (!settings) return
    const next = await window.crew.updateSettings({ [key]: !settings[key] } as Partial<Settings>)
    setSettings(next)
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal__title">Settings</h2>
        {!settings ? (
          <div className="settings__loading">Loading…</div>
        ) : (
          <div className="settings__list">
            {TOGGLES.map((t) => (
              <button key={t.key} type="button" className="settings-row" onClick={() => void toggle(t.key)}>
                <span className="settings-row__text">
                  <span className="settings-row__label">{t.label}</span>
                  <span className="settings-row__desc">{t.desc}</span>
                </span>
                <span className={`switch ${settings[t.key] ? 'is-on' : ''}`} aria-hidden>
                  <span className="switch__knob" />
                </span>
              </button>
            ))}
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
