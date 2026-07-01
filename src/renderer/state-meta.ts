import type { SessionState } from '../shared/types'

export interface StateMeta {
  label: string
  color: string
  /** Character animation bucket driven by this state. */
  anim: 'start' | 'run' | 'wait' | 'sleep' | 'gone'
}

export const STATE_META: Record<SessionState, StateMeta> = {
  STARTING: { label: 'starting', color: '#6c8ebf', anim: 'start' },
  WORKING: { label: 'working', color: '#43b581', anim: 'run' },
  WAITING_INPUT: { label: 'waiting for you', color: '#f0464a', anim: 'wait' },
  WAITING_APPROVAL: { label: 'needs approval', color: '#faa61a', anim: 'wait' },
  IDLE: { label: 'idle', color: '#767b85', anim: 'sleep' },
  EXITED: { label: 'exited', color: '#767b85', anim: 'gone' },
  ERROR: { label: 'error', color: '#f0464a', anim: 'gone' }
}

// Roster sort priority: who needs you first, then who's busy, then the rest.
const RANK: Record<SessionState, number> = {
  WAITING_APPROVAL: 0,
  WAITING_INPUT: 1,
  WORKING: 2,
  STARTING: 3,
  IDLE: 4,
  ERROR: 5,
  EXITED: 6
}

export function stateRank(state: SessionState): number {
  return RANK[state]
}

export function formatSince(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00'
  if (n < 10) return '$' + n.toFixed(2)
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
