import type { SessionState } from '../shared/types'

export interface StateMeta {
  /** Human phrase used in tooltips and the command palette. */
  label: string
  /** Uppercase label shown in status chips/badges. */
  short: string
  /**
   * Visual treatment in the Obsidian status system:
   * working = cobalt label/chip, attention = inverted ivory chip (loudest),
   * idle = muted text, error = restrained danger.
   */
  tone: 'working' | 'attention' | 'idle' | 'error'
  /** Dot color (used on the collapsed rail and legacy contexts). */
  color: string
  /** Character animation bucket driven by this state. */
  anim: 'start' | 'run' | 'wait' | 'sleep' | 'gone'
}

export const STATE_META: Record<SessionState, StateMeta> = {
  STARTING: { label: 'starting', short: 'STARTING', tone: 'idle', color: '#8F8E88', anim: 'start' },
  WORKING: { label: 'working', short: 'WORKING', tone: 'working', color: '#5F79FF', anim: 'run' },
  WAITING_INPUT: { label: 'waiting for you', short: 'WAITING', tone: 'attention', color: '#F2F1EA', anim: 'wait' },
  WAITING_APPROVAL: { label: 'needs approval', short: 'APPROVE', tone: 'attention', color: '#F2F1EA', anim: 'wait' },
  IDLE: { label: 'idle', short: 'IDLE', tone: 'idle', color: '#8F8E88', anim: 'sleep' },
  EXITED: { label: 'exited', short: 'EXITED', tone: 'idle', color: '#8F8E88', anim: 'gone' },
  ERROR: { label: 'error', short: 'ERROR', tone: 'error', color: '#e5484d', anim: 'gone' }
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

export function formatCredits(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1)
}
