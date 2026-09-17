import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let active = true
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function emit(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

function reconcileTimer(): void {
  if (active && listeners.size > 0 && !timer) timer = setInterval(emit, 1000)
  if ((!active || listeners.size === 0) && timer) {
    clearInterval(timer)
    timer = undefined
  }
}

export function subscribeNow(listener: () => void): () => void {
  const first = listeners.size === 0
  listeners.add(listener)
  if (active && first) now = Date.now()
  reconcileTimer()
  return () => {
    listeners.delete(listener)
    reconcileTimer()
  }
}

export function getNowSnapshot(): number {
  return now
}

export function setNowClockActive(next: boolean): void {
  if (active === next) return
  active = next
  if (active) emit()
  reconcileTimer()
}

export function useNow(): number {
  return useSyncExternalStore(subscribeNow, getNowSnapshot, getNowSnapshot)
}

export function resetNowClockForTests(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  listeners.clear()
  active = true
  now = Date.now()
}
