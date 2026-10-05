import { describe, expect, it } from 'vitest'
import {
  defaultLaneAgent,
  findResumeCandidate,
  isProjectDir,
  suggestCwd,
  getCopilotLaunchArgs,
  getCopilotModelSelection
} from '../src/renderer/new-session-model'
import type { CopilotModelCatalog } from '../src/shared/copilot-models'
import type { SessionInfo } from '../src/shared/types'

const failed: CopilotModelCatalog = {
  models: [],
  source: 'cli',
  error: 'CLI unavailable'
}

const empty: CopilotModelCatalog = {
  models: [],
  source: 'cli'
}

const available: CopilotModelCatalog = {
  models: ['auto', 'claude-sonnet-5'],
  source: 'cli'
}

describe('optional Copilot model selection', () => {
  it.each([
    ['loading', null],
    ['failed', failed],
    ['empty', empty]
  ])('hides model selection and accepts the CLI default while %s', (_name, catalog) => {
    expect(getCopilotModelSelection(catalog, 'gpt-6-astra')).toEqual({
      visible: false,
      valid: true
    })
    expect(getCopilotLaunchArgs(['--banner'], catalog, 'gpt-6-astra')).toEqual(['--banner'])
  })

  it('shows a successful catalog and rejects an unavailable explicit selection', () => {
    expect(getCopilotModelSelection(available, 'gpt-6-astra')).toEqual({
      visible: true,
      valid: false
    })
  })

  it('adds a listed explicit model without mutating preset arguments', () => {
    const presetArgs = ['--banner', '--model=old']
    expect(getCopilotModelSelection(available, 'auto')).toEqual({
      visible: true,
      valid: true
    })
    expect(getCopilotLaunchArgs(presetArgs, available, 'auto')).toEqual([
      '--banner',
      '--model',
      'auto'
    ])
    expect(presetArgs).toEqual(['--banner', '--model=old'])
  })
})

describe('defaultLaneAgent', () => {
  // A new roster row's picker shows DEFAULT_COPILOT_MODEL the instant
  // copilot-cli is chosen, even before a catalog has loaded — so the stored
  // agent must carry that same model, or the row looks valid while
  // validateRoster still rejects it for a missing model.
  it('defaults a Copilot preset row to DEFAULT_COPILOT_MODEL, matching what the picker displays', () => {
    expect(defaultLaneAgent('copilot-cli')).toEqual({ presetId: 'copilot-cli', model: 'gpt-6-astra' })
  })

  it('leaves non-Copilot presets modelless, since their picker offers none', () => {
    expect(defaultLaneAgent('shell')).toEqual({ presetId: 'shell', model: null })
    expect(defaultLaneAgent('claude-code')).toEqual({ presetId: 'claude-code', model: null })
  })
})

const HOME = '/Users/alex'

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    label: 'Session',
    characterId: 'c1',
    color: '#fff',
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: HOME,
    state: 'idle',
    status: 'active',
    pid: 1,
    exitCode: null,
    costUsd: 0,
    creditsUsed: 0,
    autopilot: false,
    createdAt: 1000,
    stateChangedAt: 1000,
    ...over
  } as SessionInfo
}

describe('finding a session to resume instead of duplicating', () => {
  it('returns nothing when no existing session is close enough', () => {
    const list = [session({ id: 'a', label: 'Write the docs' })]
    expect(findResumeCandidate({ label: 'Fix the parser', cwd: HOME }, list, HOME)).toBeNull()
  })

  it('matches an existing session by label, ignoring case and spacing', () => {
    const list = [session({ id: 'a', label: 'Fix Icon Positioning Bug' })]
    const hit = findResumeCandidate({ label: '  fix   icon positioning bug ', cwd: HOME }, list, HOME)
    expect(hit?.session.id).toBe('a')
    expect(hit?.reason).toBe('label')
  })

  it('does not treat the home directory as a project match', () => {
    // Every session in the real store has cwd = $HOME. Matching on it would
    // offer to resume an unrelated session every single time.
    const list = [session({ id: 'a', label: 'Something else', cwd: HOME })]
    expect(findResumeCandidate({ label: 'Brand new job', cwd: HOME }, list, HOME)).toBeNull()
  })

  it('matches on a real project directory even when the label differs', () => {
    const list = [session({ id: 'a', label: 'Old name', cwd: '/Users/alex/crew' })]
    const hit = findResumeCandidate({ label: 'New name', cwd: '/Users/alex/crew' }, list, HOME)
    expect(hit?.session.id).toBe('a')
    expect(hit?.reason).toBe('directory')
  })

  it('prefers a session matching both label and directory over either alone', () => {
    const list = [
      session({ id: 'label-only', label: 'Ship release', cwd: HOME }),
      session({ id: 'dir-only', label: 'Unrelated', cwd: '/Users/alex/crew' }),
      session({ id: 'both', label: 'Ship release', cwd: '/Users/alex/crew' })
    ]
    const hit = findResumeCandidate({ label: 'Ship release', cwd: '/Users/alex/crew' }, list, HOME)
    expect(hit?.session.id).toBe('both')
    expect(hit?.reason).toBe('label+directory')
  })

  it('breaks ties on the most recently prompted session', () => {
    const list = [
      session({ id: 'older', label: 'Same job', createdAt: 1, lastPromptAt: 100 }),
      session({ id: 'newer', label: 'Same job', createdAt: 2, lastPromptAt: 900 })
    ]
    expect(findResumeCandidate({ label: 'Same job', cwd: HOME }, list, HOME)?.session.id).toBe('newer')
  })

  it('falls back to createdAt when a session was never prompted', () => {
    const list = [
      session({ id: 'older', label: 'Same job', createdAt: 100 }),
      session({ id: 'newer', label: 'Same job', createdAt: 900 })
    ]
    expect(findResumeCandidate({ label: 'Same job', cwd: HOME }, list, HOME)?.session.id).toBe('newer')
  })

  it('ignores sessions that failed to start, which have no context to strand', () => {
    const list = [session({ id: 'a', label: 'Same job', status: 'error' })]
    expect(findResumeCandidate({ label: 'Same job', cwd: HOME }, list, HOME)).toBeNull()
  })

  it('still offers an exited session, because that is where context gets stranded', () => {
    const list = [session({ id: 'a', label: 'Same job', status: 'exited' })]
    expect(findResumeCandidate({ label: 'Same job', cwd: HOME }, list, HOME)?.session.id).toBe('a')
  })

  it('ignores a blank label so an unnamed draft never matches everything', () => {
    const list = [session({ id: 'a', label: '' })]
    expect(findResumeCandidate({ label: '   ', cwd: HOME }, list, HOME)).toBeNull()
  })

  it('excludes a session by id so editing cannot match itself', () => {
    const list = [session({ id: 'self', label: 'Same job' })]
    expect(findResumeCandidate({ label: 'Same job', cwd: HOME, excludeId: 'self' }, list, HOME)).toBeNull()
  })
})

describe('suggesting a working directory for a new session', () => {
  it('falls back to home when there is no history at all', () => {
    expect(suggestCwd('Anything', [], [], HOME)).toBe(HOME)
  })

  it('reuses the directory this label was last run in', () => {
    const list = [session({ id: 'a', label: 'Ship Crew', cwd: '/Users/alex/crew' })]
    expect(suggestCwd('Ship Crew', list, [], HOME)).toBe('/Users/alex/crew')
  })

  it('matches the label case-insensitively, like the resume offer does', () => {
    const list = [session({ id: 'a', label: 'Ship Crew', cwd: '/Users/alex/crew' })]
    expect(suggestCwd('  ship   crew ', list, [], HOME)).toBe('/Users/alex/crew')
  })

  it('prefers the most recently prompted session when a label was run twice', () => {
    const list = [
      session({ id: 'old', label: 'Ship Crew', cwd: '/Users/alex/old', lastPromptAt: 10 }),
      session({ id: 'new', label: 'Ship Crew', cwd: '/Users/alex/crew', lastPromptAt: 99 })
    ]
    expect(suggestCwd('Ship Crew', list, [], HOME)).toBe('/Users/alex/crew')
  })

  it('ignores prior sessions that only ever ran in home', () => {
    // 131 of 131 real sessions are in this state, so honouring them would
    // make the suggestion always $HOME and the feature pointless.
    const list = [session({ id: 'a', label: 'Ship Crew', cwd: HOME })]
    expect(suggestCwd('Ship Crew', list, ['/Users/alex/crew'], HOME)).toBe('/Users/alex/crew')
  })

  it('falls back to the most recent directory when the label is new', () => {
    expect(suggestCwd('Brand new', [], ['/Users/alex/crew', '/Users/alex/apps'], HOME)).toBe(
      '/Users/alex/crew'
    )
  })

  it('prefers a label match over the recents list', () => {
    const list = [session({ id: 'a', label: 'Ship Crew', cwd: '/Users/alex/crew' })]
    expect(suggestCwd('Ship Crew', list, ['/Users/alex/apps'], HOME)).toBe('/Users/alex/crew')
  })

  it('ignores a blank label rather than matching an unnamed session', () => {
    const list = [session({ id: 'a', label: '', cwd: '/Users/alex/crew' })]
    expect(suggestCwd('   ', list, [], HOME)).toBe(HOME)
  })
})

describe('recording a directory as recent', () => {
  it('ignores home, which is what every session used before this existed', () => {
    expect(isProjectDir(HOME, HOME)).toBe(false)
  })

  it('ignores a blank or whitespace directory', () => {
    expect(isProjectDir('   ', HOME)).toBe(false)
  })

  it('ignores a trailing-slash spelling of home', () => {
    expect(isProjectDir(HOME + '/', HOME)).toBe(false)
  })

  it('accepts a real project directory', () => {
    expect(isProjectDir('/Users/alex/crew', HOME)).toBe(true)
  })
})
