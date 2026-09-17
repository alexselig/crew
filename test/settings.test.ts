import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/store'

const settingsModal = readFileSync(
  new URL('../src/renderer/components/SettingsModal.tsx', import.meta.url),
  'utf8'
)

describe('DEFAULT_SETTINGS — GitHub button', () => {
  it('shows the GitHub button by default', () => {
    expect(DEFAULT_SETTINGS.showGithubButton).toBe(true)
  })

  it('opens the repo on click by default (in addition to copying)', () => {
    expect(DEFAULT_SETTINGS.githubButtonOpensRepo).toBe(true)
  })

  it('keeps the legacy foreground-notification field without exposing an obsolete toggle', () => {
    expect(DEFAULT_SETTINGS).toHaveProperty('notifyOnlyWhenUnfocused')
    expect(settingsModal).not.toContain('Only when unfocused')
    expect(settingsModal).not.toContain("key: 'notifyOnlyWhenUnfocused'")
  })
})
