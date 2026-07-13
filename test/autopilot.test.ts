import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutopilotWatcher,
  isAutopilotMode,
  isClaudeSession,
  isCopilotAutopilot,
  isCopilotSession,
  latestCopilotFooterMode,
  latestPermissionMode,
  projectDirFor
} from '../src/main/autopilot'

describe('isClaudeSession', () => {
  it('matches the claude-code preset', () => {
    expect(isClaudeSession({ presetId: 'claude-code', command: 'claude' })).toBe(true)
  })

  it('matches a bare claude command regardless of preset', () => {
    expect(isClaudeSession({ presetId: null, command: '/usr/local/bin/claude' })).toBe(true)
  })

  it('rejects other agents', () => {
    expect(isClaudeSession({ presetId: 'copilot-cli', command: 'copilot' })).toBe(false)
    expect(isClaudeSession({ presetId: 'shell', command: '/bin/zsh' })).toBe(false)
  })
})

describe('isCopilotSession', () => {
  it('matches the copilot-cli preset or a bare copilot command', () => {
    expect(isCopilotSession({ presetId: 'copilot-cli', command: 'copilot' })).toBe(true)
    expect(isCopilotSession({ presetId: null, command: '/opt/gh/copilot' })).toBe(true)
  })

  it('rejects other agents', () => {
    expect(isCopilotSession({ presetId: 'claude-code', command: 'claude' })).toBe(false)
  })
})

describe('latestCopilotFooterMode', () => {
  // Real ANSI-stripped Copilot CLI footers (Shift+Tab cycles default→plan→autopilot).
  const DEFAULT_FOOTER = '/ commands \u00b7 ? help \u00b7 \u2192 next tab'
  const PLAN_FOOTER = 'plan \u00b7 / commands \u00b7 ? help \u00b7 \u2192 next tab'
  const AUTOPILOT_FOOTER = 'autopilot \u00b7 / commands \u00b7 \u2192 next tab'

  it('reads the mode token that precedes the footer', () => {
    expect(latestCopilotFooterMode(AUTOPILOT_FOOTER)).toBe('autopilot')
    expect(latestCopilotFooterMode(PLAN_FOOTER)).toBe('plan')
    expect(latestCopilotFooterMode(DEFAULT_FOOTER)).toBe('default')
  })

  it('returns null when no footer is present', () => {
    expect(latestCopilotFooterMode('just some agent output about autopilot')).toBeNull()
    expect(latestCopilotFooterMode('')).toBeNull()
  })

  it('uses the LAST footer when several are in the tail', () => {
    // Turned autopilot on, then back off: the newest footer wins.
    expect(latestCopilotFooterMode(`${AUTOPILOT_FOOTER}\n spinner… \n${DEFAULT_FOOTER}`)).toBe('default')
    // On during a burst of streaming with no newer footer stays autopilot.
    expect(latestCopilotFooterMode(`${DEFAULT_FOOTER}\n…\n${AUTOPILOT_FOOTER}\nworking…`)).toBe('autopilot')
  })

  it('is not fooled by the word "autopilot" in prose (needs the footer separator)', () => {
    expect(latestCopilotFooterMode('the user asked about autopilot / commands earlier')).toBe('default')
  })

  it('tolerates narrow-terminal truncation of the label (real captures)', () => {
    // Copilot truncates the label and drops the spaces around "·" when the
    // terminal is narrow (grid-view tiles); we must still detect autopilot.
    expect(latestCopilotFooterMode('autopilo\u00b7/ commands \u00b7 \u2192 next')).toBe('autopilot')
    expect(latestCopilotFooterMode('autopi\u00b7 / commands \u00b7 \u2192')).toBe('autopilot')
    expect(latestCopilotFooterMode('autopi\u00b7 / commands')).toBe('autopilot')
    // A narrow default footer has no "<label> ·" before "/ commands".
    expect(latestCopilotFooterMode('/ commands \u00b7 ? he')).toBe('default')
  })

  it('isCopilotAutopilot maps the mode to a boolean, null when undetermined', () => {
    expect(isCopilotAutopilot(AUTOPILOT_FOOTER)).toBe(true)
    expect(isCopilotAutopilot(PLAN_FOOTER)).toBe(false)
    expect(isCopilotAutopilot(DEFAULT_FOOTER)).toBe(false)
    expect(isCopilotAutopilot('no footer yet')).toBeNull()
  })
})

describe('projectDirFor', () => {
  it('encodes non-alphanumeric characters as dashes', () => {
    expect(projectDirFor('/Users/alex/app')).toMatch(/[/\\]-Users-alex-app$/)
    expect(projectDirFor('/Users/a.b_c/my project')).toMatch(/[/\\]-Users-a-b-c-my-project$/)
  })
})

describe('latestPermissionMode', () => {
  it('returns the last permissionMode in the text', () => {
    const text = [
      '{"type":"user","permissionMode":"default","message":{}}',
      '{"type":"assistant","message":{}}',
      '{"type":"user","permissionMode":"acceptEdits","message":{}}'
    ].join('\n')
    expect(latestPermissionMode(text)).toBe('acceptEdits')
  })

  it('returns null when absent', () => {
    expect(latestPermissionMode('{"type":"user"}')).toBeNull()
  })

  it('is not stateful across calls', () => {
    expect(latestPermissionMode('"permissionMode":"acceptEdits"')).toBe('acceptEdits')
    expect(latestPermissionMode('"permissionMode":"default"')).toBe('default')
    expect(latestPermissionMode('no mode here')).toBeNull()
  })
})

describe('isAutopilotMode', () => {
  it('treats acceptEdits and bypassPermissions as autopilot', () => {
    expect(isAutopilotMode('acceptEdits')).toBe(true)
    expect(isAutopilotMode('bypassPermissions')).toBe(true)
  })

  it('treats default/plan/null as not autopilot', () => {
    expect(isAutopilotMode('default')).toBe(false)
    expect(isAutopilotMode('plan')).toBe(false)
    expect(isAutopilotMode(null)).toBe(false)
  })
})

describe('AutopilotWatcher', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup(): { projectsDir: string; projectDir: string; cwd: string } {
    const projectsDir = mkdtempSync(join(tmpdir(), 'crew-autopilot-'))
    dirs.push(projectsDir)
    const cwd = '/work/app'
    const projectDir = projectDirFor(cwd, projectsDir)
    mkdirSync(projectDir, { recursive: true })
    return { projectsDir, projectDir, cwd }
  }

  function writeTranscript(projectDir: string, name: string, lines: string[], mtimeSec: number): void {
    const path = join(projectDir, name)
    writeFileSync(path, lines.join('\n') + '\n')
    utimesSync(path, mtimeSec, mtimeSec)
  }

  it('is false when no transcript exists', () => {
    const projectsDir = mkdtempSync(join(tmpdir(), 'crew-autopilot-'))
    dirs.push(projectsDir)
    const watcher = new AutopilotWatcher(projectsDir)
    expect(watcher.isAutopilot('s1', '/work/app')).toBe(false)
  })

  it('reads the NEWEST transcript for the latest mode', () => {
    const { projectsDir, projectDir, cwd } = setup()
    writeTranscript(projectDir, 'old.jsonl', ['{"type":"user","permissionMode":"default"}'], 1_000_000)
    writeTranscript(projectDir, 'new.jsonl', ['{"type":"user","permissionMode":"acceptEdits"}'], 2_000_000)
    const watcher = new AutopilotWatcher(projectsDir)
    expect(watcher.isAutopilot('s1', cwd)).toBe(true)
  })

  it('uses the last permissionMode within a transcript', () => {
    const { projectsDir, projectDir, cwd } = setup()
    writeTranscript(
      projectDir,
      'session.jsonl',
      [
        '{"type":"user","permissionMode":"acceptEdits"}',
        '{"type":"assistant"}',
        '{"type":"user","permissionMode":"default"}'
      ],
      1_000_000
    )
    const watcher = new AutopilotWatcher(projectsDir)
    expect(watcher.isAutopilot('s1', cwd)).toBe(false)
  })

  it('reflects a change once the transcript is updated', () => {
    const { projectsDir, projectDir, cwd } = setup()
    writeTranscript(projectDir, 'session.jsonl', ['{"type":"user","permissionMode":"default"}'], 1_000_000)
    const watcher = new AutopilotWatcher(projectsDir)
    expect(watcher.isAutopilot('s1', cwd)).toBe(false)
    // Grow the file + bump mtime → watcher re-reads and sees autopilot.
    writeTranscript(
      projectDir,
      'session.jsonl',
      ['{"type":"user","permissionMode":"default"}', '{"type":"user","permissionMode":"acceptEdits"}'],
      2_000_000
    )
    expect(watcher.isAutopilot('s1', cwd)).toBe(true)
  })

  it('forget() is a no-op when the session is unknown', () => {
    const watcher = new AutopilotWatcher()
    expect(() => watcher.forget('nope')).not.toThrow()
  })
})
