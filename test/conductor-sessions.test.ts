import { describe, it, expect, vi } from 'vitest'
import { createLaneSessionBridge } from '../src/main/conductor-sessions'
import { withCopilotModel } from '../src/shared/copilot-models'
import type { SessionManager } from '../src/main/session-manager'

function fakeManager(overrides: Partial<Pick<SessionManager, 'create' | 'close'>> = {}) {
  return {
    create: vi.fn((req: { presetId: string | null; command: string; args: string[]; cwd: string; label?: string }) => ({
      id: `sess-${req.cwd.split('/').pop()}`,
      presetId: req.presetId,
      command: req.command,
      args: req.args,
      cwd: req.cwd,
      state: 'STARTING',
      status: 'active',
      pid: 4242
    })),
    close: vi.fn(),
    ...overrides
  } as unknown as Pick<SessionManager, 'create' | 'close'>
}

const resolveShell = (presetId: string) =>
  presetId === 'shell' ? { command: '/bin/sh', args: [] } : null

const resolveCopilot = (presetId: string) =>
  presetId === 'copilot-cli' ? { command: 'copilot', args: ['--foo'] } : null

describe('createLaneSessionBridge', () => {
  it('rejects an unknown presetId and creates nothing', async () => {
    const manager = fakeManager()
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveShell })

    await expect(
      bridge.createSession({ cwd: '/lane', presetId: 'nonexistent', model: null, label: 'builder' })
    ).rejects.toThrow(/nonexistent/)
    expect(manager.create).not.toHaveBeenCalled()
  })

  it('creates a session with the preset command/args and the lane worktree as cwd', async () => {
    const manager = fakeManager()
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveShell })

    const result = await bridge.createSession({
      cwd: '/lanes/builder',
      presetId: 'shell',
      model: null,
      label: 'builder'
    })

    expect(result.id).toBe('sess-builder')
    expect(manager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: 'shell',
        command: '/bin/sh',
        args: [],
        cwd: '/lanes/builder',
        label: 'builder'
      })
    )
  })

  it('delegates closeSession to manager.close', () => {
    const manager = fakeManager()
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveShell })

    bridge.closeSession('sess-1')

    expect(manager.close).toHaveBeenCalledWith('sess-1')
  })

  it('threads the model into the spawned session args, the same way New Session does', async () => {
    const manager = fakeManager()
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveCopilot })

    await bridge.createSession({
      cwd: '/lanes/builder',
      presetId: 'copilot-cli',
      model: 'gpt-6-astra',
      label: 'builder'
    })

    expect(manager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        args: withCopilotModel(['--foo'], 'gpt-6-astra')
      })
    )
  })

  it('leaves preset args untouched when model is null', async () => {
    const manager = fakeManager()
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveCopilot })

    await bridge.createSession({
      cwd: '/lanes/builder',
      presetId: 'copilot-cli',
      model: null,
      label: 'builder'
    })

    expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ args: ['--foo'] }))
  })

  it('rejects a resolved preset with an empty command and creates nothing', async () => {
    const manager = fakeManager()
    const resolveEmpty = (presetId: string) =>
      presetId === 'broken' ? { command: '', args: [] } : null
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveEmpty })

    await expect(
      bridge.createSession({ cwd: '/lane', presetId: 'broken', model: null, label: 'builder' })
    ).rejects.toThrow(/empty command/)
    expect(manager.create).not.toHaveBeenCalled()
  })

  it('throws and closes the dead session when manager.create returns a failed SessionInfo', async () => {
    const manager = fakeManager({
      create: vi.fn(() => ({
        id: 'sess-dead',
        presetId: 'shell',
        command: '/bin/sh',
        args: [],
        cwd: '/lanes/builder',
        state: 'ERROR',
        status: 'error',
        pid: null,
        errorMessage: 'Failed to launch /bin/sh in /lanes/builder: spawn ENOENT'
      })) as unknown as SessionManager['create']
    })
    const bridge = createLaneSessionBridge({ manager, resolvePreset: resolveShell })

    await expect(
      bridge.createSession({ cwd: '/lanes/builder', presetId: 'shell', model: null, label: 'builder' })
    ).rejects.toThrow(/failed to launch/)
    expect(manager.close).toHaveBeenCalledWith('sess-dead')
  })
})
