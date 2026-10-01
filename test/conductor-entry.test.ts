import { describe, expect, it } from 'vitest'
import { conductorLabel, conductorSessionRequest } from '../src/shared/conductor-entry'
import type { Preset, Workspace } from '../src/shared/types'

const workspace = (name: string): Workspace => ({
  id: 'ws-1',
  name,
  order: 0,
  createdAt: 0,
  conducted: true
})

const preset = (over: Partial<Preset> = {}): Preset => ({
  id: 'copilot',
  name: 'GitHub Copilot',
  command: 'copilot',
  args: ['--banner'],
  ...over
})

describe('conductorLabel', () => {
  it('names the conductor after its workspace', () => {
    expect(conductorLabel('Payments')).toBe('Payments - Conductor')
  })

  it('keeps two conductors apart', () => {
    // The roster is flat, so a bare "Conductor" would be ambiguous the moment
    // a second conducted workspace exists.
    expect(conductorLabel('Payments')).not.toBe(conductorLabel('Search'))
  })
})

describe('conductorSessionRequest', () => {
  const start = { cwd: '/repo', prompt: '  Add OAuth sign-in  ' }

  it('builds the conductor session for a new conducted workspace', () => {
    const req = conductorSessionRequest(workspace('Payments'), preset(), start)
    expect(req).toEqual({
      presetId: 'copilot',
      command: 'copilot',
      args: ['--banner'],
      cwd: '/repo',
      label: 'Payments - Conductor',
      initialPrompt: 'Add OAuth sign-in',
      workspaceIds: ['ws-1']
    })
  })

  it('puts the conductor in its workspace at creation, not afterwards', () => {
    // A conductor that exists for a moment outside its workspace shows up in
    // All Sessions as an orphan.
    expect(conductorSessionRequest(workspace('Payments'), preset(), start)?.workspaceIds).toEqual(['ws-1'])
  })

  it('copies the preset args rather than sharing them', () => {
    const p = preset()
    const req = conductorSessionRequest(workspace('Payments'), p, start)
    req?.args.push('--mutated')
    expect(p.args).toEqual(['--banner'])
  })

  it('refuses an unknown preset rather than falling back to a shell', () => {
    // Fail-closed, like the lane session bridge: a conductor that is secretly
    // a bare shell looks started and then never plans anything.
    expect(conductorSessionRequest(workspace('Payments'), undefined, start)).toBeNull()
  })

  it('refuses a preset that resolved to an empty command', () => {
    expect(conductorSessionRequest(workspace('Payments'), preset({ command: '   ' }), start)).toBeNull()
  })

  it('refuses a conductor with no brief', () => {
    // There is nothing for a conductor to plan without one, and the dialog
    // disables its button for the same reason.
    expect(conductorSessionRequest(workspace('Payments'), preset(), { cwd: '/repo', prompt: '   ' })).toBeNull()
  })

  it('tolerates a preset with no args', () => {
    const req = conductorSessionRequest(
      workspace('Payments'),
      { id: 'bare', name: 'Bare', command: 'sh' } as Preset,
      start
    )
    expect(req?.args).toEqual([])
  })
})
