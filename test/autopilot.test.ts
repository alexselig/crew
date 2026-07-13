import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutopilotWatcher,
  CopilotAutopilotWatcher,
  copilotEventsPath,
  isAutopilotMode,
  isClaudeSession,
  isCopilotAutopilotMode,
  isCopilotSession,
  latestCopilotMode,
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

describe('latestCopilotMode', () => {
  // Real compact on-disk lines from ~/.copilot/session-state/<id>/events.jsonl.
  const line = (newMode: string, prev = 'interactive'): string =>
    `{"type":"session.mode_changed","data":{"previousMode":"${prev}","newMode":"${newMode}"},"id":"x","timestamp":"t"}`

  it('returns the newMode of the LAST mode_changed event in the log tail', () => {
    const log = [
      line('autopilot'),
      '{"type":"assistant.message","data":{}}',
      line('interactive', 'autopilot'),
      '{"type":"tool.execution_start","data":{}}',
      line('autopilot', 'interactive')
    ].join('\n')
    expect(latestCopilotMode(log)).toBe('autopilot')
  })

  it('reads plan and interactive too', () => {
    expect(latestCopilotMode(line('plan'))).toBe('plan')
    expect(latestCopilotMode(line('interactive', 'autopilot'))).toBe('interactive')
  })

  it('returns null when the tail has no mode-change line', () => {
    expect(latestCopilotMode('{"type":"assistant.message","data":{}}\n')).toBeNull()
    expect(latestCopilotMode('')).toBeNull()
  })

  it('is not fooled by newMode in unrelated events', () => {
    expect(latestCopilotMode('{"type":"other","data":{"newMode":"autopilot"}}')).toBeNull()
  })
})

describe('isCopilotAutopilotMode', () => {
  it('treats only "autopilot" as autonomous', () => {
    expect(isCopilotAutopilotMode('autopilot')).toBe(true)
    expect(isCopilotAutopilotMode('interactive')).toBe(false)
    expect(isCopilotAutopilotMode('plan')).toBe(false)
    expect(isCopilotAutopilotMode(null)).toBe(false)
  })
})

describe('copilotEventsPath', () => {
  it('builds session-state/<agentSessionId>/events.jsonl', () => {
    expect(copilotEventsPath('abc-123', '/base')).toMatch(/[/\\]base[/\\]abc-123[/\\]events\.jsonl$/)
  })
})

describe('CopilotAutopilotWatcher', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup(): { stateDir: string; id: string; path: string; write: (lines: string[]) => void } {
    const stateDir = mkdtempSync(join(tmpdir(), 'crew-copilot-'))
    dirs.push(stateDir)
    const id = 'agent-uuid-1'
    mkdirSync(join(stateDir, id), { recursive: true })
    const path = join(stateDir, id, 'events.jsonl')
    const write = (lines: string[]): void => writeFileSync(path, lines.join('\n') + '\n')
    return { stateDir, id, path, write }
  }
  const mode = (m: string, p = 'interactive'): string =>
    `{"type":"session.mode_changed","data":{"previousMode":"${p}","newMode":"${m}"}}`

  it('is false when the session has no event log yet', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crew-copilot-'))
    dirs.push(stateDir)
    const w = new CopilotAutopilotWatcher(stateDir)
    expect(w.isAutopilot('s1', 'missing-uuid')).toBe(false)
  })

  it('is false when agentSessionId is undefined', () => {
    const w = new CopilotAutopilotWatcher()
    expect(w.isAutopilot('s1', undefined)).toBe(false)
  })

  it('assumes interactive on first sight, ignoring pre-existing history', () => {
    // A session resumed by Crew launches interactive even if its log ends in an
    // autopilot line from a previous run — first sight must not report autopilot.
    const { stateDir, id, write } = setup()
    write([mode('autopilot')])
    const w = new CopilotAutopilotWatcher(stateDir)
    expect(w.isAutopilot('s1', id)).toBe(false)
  })

  it('flips to autopilot when a mode change is APPENDED after watching starts', () => {
    const { stateDir, id, write } = setup()
    write(['{"type":"session.start","data":{}}'])
    const w = new CopilotAutopilotWatcher(stateDir)
    expect(w.isAutopilot('s1', id)).toBe(false)
    write(['{"type":"session.start","data":{}}', mode('autopilot')])
    expect(w.isAutopilot('s1', id)).toBe(true)
    // …and back off.
    write(['{"type":"session.start","data":{}}', mode('autopilot'), mode('interactive', 'autopilot')])
    expect(w.isAutopilot('s1', id)).toBe(false)
  })

  it('keeps the last known mode when appended output has no mode-change line', () => {
    const { stateDir, id, write } = setup()
    write(['{"type":"session.start","data":{}}'])
    const w = new CopilotAutopilotWatcher(stateDir)
    w.isAutopilot('s1', id)
    write(['{"type":"session.start","data":{}}', mode('autopilot')])
    expect(w.isAutopilot('s1', id)).toBe(true)
    write(['{"type":"session.start","data":{}}', mode('autopilot'), '{"type":"assistant.message","data":{}}'])
    expect(w.isAutopilot('s1', id)).toBe(true)
  })

  it('forget() drops cached state without throwing', () => {
    const w = new CopilotAutopilotWatcher()
    expect(() => w.forget('nope')).not.toThrow()
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
