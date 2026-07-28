import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCrewHookDir, crewHookFor } from '../src/main/crew-hook'

const dir = ensureCrewHookDir(mkdtempSync(join(tmpdir(), 'crewhook-test-')))

describe('crew-hook — script materialization', () => {
  it('writes all zsh + bash integration files', () => {
    for (const f of ['.zshenv', '.zshrc', '.zprofile', '.zlogin', 'crew-hook.bash']) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
  })

  it('emits OSC 133 and sources the user config first (safety)', () => {
    const zshrc = readFileSync(join(dir, '.zshrc'), 'utf8')
    expect(zshrc).toContain('133')
    expect(zshrc).toContain('$CREW_ZDOTDIR/.zshrc') // chains the user's real rc
    const bashrc = readFileSync(join(dir, 'crew-hook.bash'), 'utf8')
    expect(bashrc).toContain('133')
    expect(bashrc).toContain('$HOME/.bashrc')
  })
})

describe('crew-hook — injection selection', () => {
  it('injects ZDOTDIR for zsh (and preserves the real one)', () => {
    const h = crewHookFor('/bin/zsh', dir)
    expect(h?.env?.ZDOTDIR).toBe(dir)
    expect(h?.env?.CREW_ZDOTDIR).toBeTruthy()
  })

  it('injects --rcfile for bash', () => {
    expect(crewHookFor('/bin/bash', dir)?.extraArgs).toEqual([
      '--rcfile',
      join(dir, 'crew-hook.bash')
    ])
  })

  it('normalizes login-shell arg0 (-zsh / -bash)', () => {
    expect(crewHookFor('-zsh', dir)?.env?.ZDOTDIR).toBe(dir)
    expect(crewHookFor('-bash', dir)?.extraArgs?.[0]).toBe('--rcfile')
  })

  it('returns null for unsupported shells (no injection)', () => {
    expect(crewHookFor('powershell.exe', dir)).toBeNull()
    expect(crewHookFor('/usr/bin/fish', dir)).toBeNull()
    expect(crewHookFor('cmd.exe', dir)).toBeNull()
  })
})
