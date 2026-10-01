import { describe, expect, it } from 'vitest'
import { conductorLabel, conductorSessionRequest, planNewWorkspace } from '../src/shared/conductor-entry'
import type { NewWorkspaceChoice } from '../src/shared/conductor-entry'
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

  it('keeps the workspace name whole, punctuation and all', () => {
    // The roster is flat, so the name in the label is the only thing telling
    // two conductors apart: an implementation that trimmed, truncated or
    // sanitised it would make names that differ late collide.
    expect(conductorLabel('Search & Ranking - v2')).toBe('Search & Ranking - v2 - Conductor')
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

  it('refuses a conductor with nowhere to run', () => {
    // An empty cwd is not an empty field: session-manager resolves it to the
    // home directory, so the conductor would start, read the wrong tree and
    // plan work for a repository nobody asked about.
    expect(conductorSessionRequest(workspace('Payments'), preset(), { cwd: '   ', prompt: 'Add OAuth' })).toBeNull()
  })

  it('trims the repository path it was given', () => {
    const req = conductorSessionRequest(workspace('Payments'), preset(), { cwd: '  /repo  ', prompt: 'Add OAuth' })
    expect(req?.cwd).toBe('/repo')
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

const choice = (over: Partial<NewWorkspaceChoice> = {}): NewWorkspaceChoice => ({
  name: 'Payments',
  conducted: true,
  presetId: 'copilot',
  cwd: '/repo',
  prompt: 'Add OAuth sign-in',
  ...over
})

describe('planNewWorkspace', () => {
  it('starts the conductor AND makes its workspace active', () => {
    // Both halves or neither: a conductor created in a workspace that is not
    // the active one renders no conductor panel at all, so the feature looks
    // broken at the exact moment it is first used.
    const plan = planNewWorkspace(workspace('Payments'), choice(), [preset()])
    expect(plan?.activateWorkspaceId).toBe('ws-1')
    expect(plan?.session).toEqual({
      presetId: 'copilot',
      command: 'copilot',
      args: ['--banner'],
      cwd: '/repo',
      label: 'Payments - Conductor',
      initialPrompt: 'Add OAuth sign-in',
      workspaceIds: ['ws-1']
    })
  })

  it('starts nothing and moves nothing for a standard workspace', () => {
    // A standard workspace is just a name: the manager stays open on the
    // view the user was already looking at.
    expect(planNewWorkspace(workspace('Payments'), choice({ conducted: false }), [preset()])).toEqual({
      activateWorkspaceId: null,
      session: null
    })
  })

  it('picks the conductor\'s agent by the id the dialog chose', () => {
    const other = preset({ id: 'claude', name: 'Claude', command: 'claude', args: [] })
    const plan = planNewWorkspace(workspace('Payments'), choice({ presetId: 'claude' }), [preset(), other])
    expect(plan?.session?.command).toBe('claude')
  })

  it('refuses the whole plan when the chosen agent is not a known preset', () => {
    // Fail-closed: no session, and nothing activated for a workspace whose
    // conductor was never started.
    expect(planNewWorkspace(workspace('Payments'), choice({ presetId: 'nope' }), [preset()])).toBeNull()
  })

  it('refuses the whole plan when the conducted form has no repository', () => {
    expect(planNewWorkspace(workspace('Payments'), choice({ cwd: '  ' }), [preset()])).toBeNull()
  })
})
