import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutopilotWatcher,
  isAutopilotMode,
  isClaudeSession,
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
