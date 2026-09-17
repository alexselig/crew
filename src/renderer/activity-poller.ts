export interface ActivityPoller {
  setActive(active: boolean): void
  dispose(): void
}

export function createActivityPoller(
  intervalMs: number,
  run: () => void | Promise<void>
): ActivityPoller {
  let active = false
  let disposed = false
  let inFlight = false
  let pending = false
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = (): void => {
    if (disposed || !active) return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    void Promise.resolve(run())
      .finally(() => {
        inFlight = false
        if (active && pending && !disposed) {
          pending = false
          tick()
        }
      })
  }

  return {
    setActive(next) {
      if (disposed || active === next) return
      active = next
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (!active) {
        pending = false
        return
      }
      tick()
      timer = setInterval(tick, intervalMs)
    },
    dispose() {
      disposed = true
      active = false
      pending = false
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
