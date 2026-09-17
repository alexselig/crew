export interface FocusableWindow {
  isFocused(): boolean
}

type Defer = (run: () => void) => void

export class AppActivityCoordinator<W extends FocusableWindow> {
  private last: boolean | undefined
  private scheduled = false

  constructor(
    private readonly windows: () => readonly W[],
    private readonly broadcast: (active: boolean) => void,
    private readonly defer: Defer = queueMicrotask
  ) {}

  current(): boolean {
    return this.windows().some((window) => window.isFocused())
  }

  recompute(): void {
    const active = this.current()
    if (active === this.last) return
    this.last = active
    this.broadcast(active)
  }

  schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.defer(() => {
      this.scheduled = false
      this.recompute()
    })
  }

  sendCurrent(send: (active: boolean) => void): void {
    send(this.current())
  }
}
