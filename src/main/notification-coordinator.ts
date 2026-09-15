import type { SessionInfo } from '../shared/types'

export interface NoticeRequest {
  title: string
  body: string
  silent: boolean
  onClick: () => void
}

export interface NoticeHandle {
  close: () => void
}

type NoticeFactory = (request: NoticeRequest) => NoticeHandle

interface PendingNotice {
  session: SessionInfo
  silent: boolean
}

export class NotificationCoordinator {
  private readonly announced = new Set<string>()
  private readonly pending = new Map<string, PendingNotice>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: NoticeHandle | null = null
  private destroyed = false

  constructor(
    private readonly showNotice: NoticeFactory,
    private readonly jumpTo: (id: string) => void,
    private readonly revealCrew: () => void
  ) {}

  queue(session: SessionInfo, silent: boolean): void {
    if (this.destroyed || this.announced.has(session.id)) return
    this.pending.set(session.id, { session: { ...session }, silent })
    this.scheduleFlush()
  }

  suppress(id: string): void {
    if (this.destroyed) return
    this.announced.add(id)
    this.pending.delete(id)
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  acknowledge(id: string): void {
    this.announced.delete(id)
    this.pending.delete(id)
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  reconcile(activeIds: ReadonlySet<string>): void {
    for (const id of this.announced) {
      if (!activeIds.has(id)) this.announced.delete(id)
    }
    for (const id of this.pending.keys()) {
      if (!activeIds.has(id)) this.pending.delete(id)
    }
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.announced.clear()
    this.closeActiveNotice()
    this.active = null
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 1000)
  }

  private flush(): void {
    this.timer = null
    if (this.destroyed || this.pending.size === 0) return

    const batch = [...this.pending.values()]
    this.pending.clear()
    for (const { session } of batch) this.announced.add(session.id)

    this.closeActiveNotice()

    const single = batch.length === 1 ? batch[0] : null
    this.active = this.showNotice({
      title: single ? single.session.label : 'Crew',
      body: single
        ? single.session.state === 'WAITING_APPROVAL'
          ? 'needs your approval'
          : 'needs your input'
        : `${batch.length} sessions need you`,
      silent: batch.every((item) => item.silent),
      onClick: single ? () => this.jumpTo(single.session.id) : this.revealCrew
    })
  }

  private closeActiveNotice(): void {
    try {
      this.active?.close()
    } catch {
      // Best-effort cleanup; a failed close must not block replacement or shutdown.
    }
  }
}
