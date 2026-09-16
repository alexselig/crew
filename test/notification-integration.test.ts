import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleNeedsYouTransition } from '../src/main/notification-integration'
import { NotificationCoordinator, type NoticeRequest } from '../src/main/notification-coordinator'
import type { SessionInfo } from '../src/shared/types'

function session(id: string): SessionInfo {
  return {
    id,
    label: `Session ${id}`,
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
    workspaceIds: [],
    createdAt: 1,
    stateChangedAt: 1
  }
}

describe('notification runtime integration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('consumes a queued wait without a notice when Crew becomes focused before flush', () => {
    const shown: NoticeRequest[] = []
    let foreground = false
    const coordinator = new NotificationCoordinator(
      (request) => {
        shown.push(request)
        return { close: vi.fn() }
      },
      vi.fn(),
      vi.fn(),
      () => foreground
    )

    handleNeedsYouTransition(
      { session: session('a'), from: 'WORKING', to: 'WAITING_INPUT' },
      { notifications: true, sound: true },
      {
        notify: (waiting, silent) => coordinator.queue(waiting, silent),
        suppress: (id) => coordinator.suppress(id)
      },
      () => foreground
    )
    foreground = true
    vi.advanceTimersByTime(1000)
    expect(shown).toEqual([])

    foreground = false
    handleNeedsYouTransition(
      { session: session('a'), from: 'WORKING', to: 'WAITING_INPUT' },
      { notifications: true, sound: true },
      {
        notify: (waiting, silent) => coordinator.queue(waiting, silent),
        suppress: (id) => coordinator.suppress(id)
      },
      () => foreground
    )
    vi.advanceTimersByTime(1000)
    expect(shown).toEqual([])

    coordinator.acknowledge('a')
    handleNeedsYouTransition(
      { session: session('a'), from: 'WORKING', to: 'WAITING_INPUT' },
      { notifications: true, sound: true },
      {
        notify: (waiting, silent) => coordinator.queue(waiting, silent),
        suppress: (id) => coordinator.suppress(id)
      },
      () => foreground
    )
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(1)
  })
})
