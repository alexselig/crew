// The app-wide terminal facade. A single global setting ("Beta Enhanced Terminal
// Interface") selects which engine every session renders and receives output
// through: the legacy direct-xterm pool (default) or the new Crew-owned engine
// pool. Consumers (hooks output routing, focus calls, dispose-on-close) import
// from here so the switch is a single source of truth.
//
// Routing is by CURRENT mode, so writeTo/focusTerminal follow the toggle. On a
// real session close, disposePooled clears BOTH pools (the session id is gone
// forever), so neither pool leaks. Switching modes at runtime does NOT dispose —
// each pool keeps its terminals (and scrollback) so toggling back is instant;
// the React views re-key on mode so they remount into the active pool.

import * as legacy from '../terminal-pool'
import * as crew from './pool'
import type { Block } from '../../shared/blocks'
import type { TranscriptBlock } from '../transcript/types'

export type EngineMode = 'legacy' | 'crew'

let mode: EngineMode = 'legacy'

export function setEngineMode(next: EngineMode): void {
  mode = next
}

export function getEngineMode(): EngineMode {
  return mode
}

export function writeTo(id: string, data: string): void {
  if (mode === 'crew') crew.writeTo(id, data)
  else legacy.writeTo(id, data)
}

export function focusTerminal(id: string): void {
  if (mode === 'crew') crew.focusTerminal(id)
  else legacy.focusTerminal(id)
}

export function disposePooled(id: string): void {
  // Session truly gone (UUID never reused) — dispose from both pools so neither
  // leaks, regardless of which engine was active while it ran.
  legacy.disposePooled(id)
  crew.disposePooled(id)
}

/** Semantic command blocks for a session — only the Crew engine produces them. */
export function getBlocks(id: string): Block[] {
  return mode === 'crew' ? crew.getBlocks(id) : []
}

/** Jump-to-prompt navigation (Crew engine only; no-op under legacy). */
export function jumpToPrompt(id: string, dir: 'prev' | 'next'): boolean {
  return mode === 'crew' ? crew.jumpToPrompt(id, dir) : false
}

/** Copy the terminal selection (Crew engine only). */
export function copySelection(id: string): Promise<string> {
  return mode === 'crew' ? crew.copySelection(id) : Promise.resolve('')
}

/** Record a submitted command line for the typed Transcript (Crew engine only). */
export function recordInput(id: string, line: string): void {
  if (mode === 'crew') crew.recordInput(id, line)
}

/** Typed session scrollback for the Transcript view (Crew engine only). */
export function getTranscript(id: string): TranscriptBlock[] {
  return mode === 'crew' ? crew.getTranscript(id) : []
}
