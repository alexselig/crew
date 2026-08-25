import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/main/store'

describe('DEFAULT_SETTINGS — GitHub button', () => {
  it('shows the GitHub button by default', () => {
    expect(DEFAULT_SETTINGS.showGithubButton).toBe(true)
  })

  it('opens the repo on click by default (in addition to copying)', () => {
    expect(DEFAULT_SETTINGS.githubButtonOpensRepo).toBe(true)
  })
})
