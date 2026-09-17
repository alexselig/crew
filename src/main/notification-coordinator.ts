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

interface ActiveNotice {
  handle: NoticeHandle
  sessionIds: ReadonlySet<string>
  generation: number
}

export class NotificationCoordinator {
  private readonly announced = new Set<string>()
  private readonly pending = new Map<string, PendingNotice>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: ActiveNotice | null = null
  private currentSessionIds: ReadonlySet<string> | null = null
  private generation = 0
  private destroyed = false

  constructor(
    private readonly showNotice: NoticeFactory,
    private readonly jumpTo: (id: string) => void,
    private readonly revealCrew: () => void,
    private readonly isForeground: () => boolean = () => false
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
    if (this.active?.sessionIds.has(id)) this.invalidateActiveNotice()
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  acknowledge(id: string): void {
    this.announced.delete(id)
    this.pending.delete(id)
    if (this.active?.sessionIds.has(id)) this.invalidateActiveNotice()
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  reconcile(activeIds: ReadonlySet<string>): void {
    this.currentSessionIds = new Set(activeIds)
    for (const id of this.announced) {
      if (!activeIds.has(id)) this.announced.delete(id)
    }
    for (const id of this.pending.keys()) {
      if (!activeIds.has(id)) this.pending.delete(id)
    }
    if (this.active && [...this.active.sessionIds].some((id) => !activeIds.has(id))) {
      this.invalidateActiveNotice()
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
    this.currentSessionIds = null
    this.invalidateActiveNotice()
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

    if (this.isForeground()) return

    this.invalidateActiveNotice()

    const single = batch.length === 1 ? batch[0] : null
    const generation = ++this.generation
    const sessionIds = new Set(batch.map(({ session }) => session.id))
    const handle = this.showNotice({
      title: single ? single.session.label : 'Crew',
      body: single
        ? single.session.state === 'WAITING_APPROVAL'
          ? 'needs your approval'
          : 'needs your input'
        : `${batch.length} sessions need you`,
      silent: batch.every((item) => item.silent),
      onClick: () => {
        if (!this.isCurrent(generation, sessionIds)) return
        if (single) this.jumpTo(single.session.id)
        else this.revealCrew()
      }
    })
    this.active = { handle, sessionIds, generation }
  }

  private isCurrent(generation: number, sessionIds: ReadonlySet<string>): boolean {
    if (this.destroyed || this.active?.generation !== generation) return false
    if (
      this.currentSessionIds &&
      [...sessionIds].some((id) => !this.currentSessionIds?.has(id))
    ) {
      return false
    }
    return true
  }

  private invalidateActiveNotice(): void {
    const active = this.active
    this.active = null
    this.generation++
    try {
      active?.handle.close()
    } catch {
      // Best-effort cleanup; a failed close must not block replacement or shutdown.
    }
  }
}
