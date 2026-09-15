import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('NotificationCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches fifty waiting sessions into one aggregate notification', () => {
    const shown: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    for (let i = 0; i < 50; i++) coordinator.queue(session(String(i)), false)
    vi.advanceTimersByTime(1000)

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'Crew', body: '50 sessions need you' })
  })

  it('does not repeat a session until input acknowledges it', () => {
    const shown: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(1)

    coordinator.acknowledge('a')
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(2)
  })

  it('uses the latest session snapshot in a pending batch', () => {
    const requests: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      requests.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())
    const first = session('a')

    coordinator.queue(first, true)
    coordinator.queue({ ...first, label: 'Updated' }, false)
    vi.advanceTimersByTime(1000)

    expect(requests[0]).toMatchObject({ title: 'Updated', silent: false })
  })

  it('suppresses a foreground session until input acknowledges it', () => {
    const shown: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    coordinator.suppress('a')
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(0)

    coordinator.acknowledge('a')
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(1)
  })

  it('closes the prior notice before showing a later batch', () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const coordinator = new NotificationCoordinator(() => {
      const close = vi.fn()
      closes.push(close)
      return { close }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    coordinator.queue(session('b'), false)
    vi.advanceTimersByTime(1000)

    expect(closes[0]).toHaveBeenCalledOnce()
  })

  it('shows a replacement notice even if the prior close throws', () => {
    const shown: NoticeRequest[] = []
    const close = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('close failed')
      })
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    coordinator.queue(session('b'), false)

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(shown).toHaveLength(2)
    expect(shown[1]).toMatchObject({ title: 'Session b' })
  })

  it('single click jumps and aggregate click reveals Crew', () => {
    const requests: NoticeRequest[] = []
    const jump = vi.fn()
    const reveal = vi.fn()
    const coordinator = new NotificationCoordinator((request) => {
      requests.push(request)
      return { close: vi.fn() }
    }, jump, reveal)

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    requests[0].onClick()
    expect(jump).toHaveBeenCalledWith('a')

    coordinator.acknowledge('a')
    coordinator.queue(session('a'), false)
    coordinator.queue(session('b'), false)
    vi.advanceTimersByTime(1000)
    requests[1].onClick()
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('reconcile and dispose cancel stale pending work', () => {
    const shown = vi.fn()
    const coordinator = new NotificationCoordinator(() => {
      shown()
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('gone'), false)
    coordinator.reconcile(new Set())
    vi.advanceTimersByTime(1000)
    expect(shown).not.toHaveBeenCalled()

    coordinator.queue(session('alive'), false)
    coordinator.dispose()
    vi.advanceTimersByTime(1000)
    expect(shown).not.toHaveBeenCalled()
  })

  it('closes the active notice during dispose', () => {
    const close = vi.fn()
    const coordinator = new NotificationCoordinator(() => {
      return { close }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('alive'), false)
    vi.advanceTimersByTime(1000)
    coordinator.dispose()

    expect(close).toHaveBeenCalledOnce()
  })

  it('swallows a throwing close during dispose', () => {
    const coordinator = new NotificationCoordinator(() => {
      return {
        close: vi.fn(() => {
          throw new Error('close failed')
        })
      }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('alive'), false)
    vi.advanceTimersByTime(1000)

    expect(() => coordinator.dispose()).not.toThrow()
  })
})
