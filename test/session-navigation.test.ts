import { describe, expect, it, vi } from 'vitest'
import { navigateToSession } from '../src/renderer/session-navigation'
import type { CustomView, SessionInfo, SessionPresentation } from '../src/shared/types'

function session(id: string, workspaceIds: string[]): SessionInfo {
  return {
    id,
    workspaceIds,
    label: id,
    characterId: 'fox',
    color: '#ff5a5a',
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: '/tmp',
    state: 'WAITING_INPUT',
    status: 'active',
    pid: 1,
    exitCode: null,
    costUsd: 0,
    creditsUsed: 0,
    autopilot: false,
    createdAt: 1,
    stateChangedAt: 1
  }
}

function customView(
  mode: CustomView['mode'],
  sessionIds: string[]
): CustomView {
  return {
    id: 'view-1',
    name: 'Queue',
    mode,
    items: sessionIds.map((sessionId) => ({ sessionId, labelSnapshot: sessionId })),
    createdAt: 1,
    updatedAt: 1
  }
}

function actions() {
  return {
    setActiveWorkspace: vi.fn(),
    setPresentation: vi.fn(),
    selectSession: vi.fn(),
    setShowNew: vi.fn()
  }
}

describe('renderer session jump navigation', () => {
  it('falls back to Recent before selecting a target hidden by a curated view', () => {
    const target = session('target', ['workspace-a'])
    const controls = actions()

    expect(
      navigateToSession(
        {
          id: target.id,
          roster: [target],
          activeWorkspace: 'workspace-a',
          presentation: { kind: 'custom', viewId: 'view-1' },
          customViews: [customView('curated-only', ['other'])]
        },
        controls
      )
    ).toBe(true)

    expect(controls.setActiveWorkspace).not.toHaveBeenCalled()
    expect(controls.setPresentation).toHaveBeenCalledWith({
      kind: 'builtin',
      mode: 'recent'
    } satisfies SessionPresentation)
    expect(controls.selectSession).toHaveBeenCalledWith(target.id)
  })

  it('clears an excluding workspace before selecting the target', () => {
    const target = session('target', ['workspace-b'])
    const controls = actions()

    navigateToSession(
      {
        id: target.id,
        roster: [target],
        activeWorkspace: 'workspace-a',
        presentation: { kind: 'custom', viewId: 'view-1' },
        customViews: [customView('ranked-plus-all', [])]
      },
      controls
    )

    expect(controls.setActiveWorkspace).toHaveBeenCalledWith(null)
    expect(controls.setPresentation).not.toHaveBeenCalled()
    expect(controls.selectSession).toHaveBeenCalledWith(target.id)
  })

  it('routes a minimized target through the standard selectSession reveal path', () => {
    const target = session('target', [])
    const minimized = new Set([target.id])
    const selected: string[] = []
    const controls = actions()
    controls.selectSession.mockImplementation((id: string) => {
      minimized.delete(id)
      selected.push(id)
    })

    navigateToSession(
      {
        id: target.id,
        roster: [target],
        activeWorkspace: null,
        presentation: { kind: 'builtin', mode: 'recent' },
        customViews: []
      },
      controls
    )

    expect(minimized.has(target.id)).toBe(false)
    expect(selected).toEqual([target.id])
    expect(controls.setShowNew).toHaveBeenCalledWith(false)
  })

  it('ignores a jump whose target is no longer in the roster', () => {
    const controls = actions()

    expect(
      navigateToSession(
        {
          id: 'gone',
          roster: [],
          activeWorkspace: null,
          presentation: { kind: 'builtin', mode: 'recent' },
          customViews: []
        },
        controls
      )
    ).toBe(false)
    expect(controls.selectSession).not.toHaveBeenCalled()
  })
})
