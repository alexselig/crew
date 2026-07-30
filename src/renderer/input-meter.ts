// input-meter.ts — estimates how much unsent input is sitting in a session's
// current prompt (typed or pasted but not yet submitted) so the UI can warn
// before a very large send. The classic case is refreshing/rehydrating a
// conversation by pasting a big blob of context, which can silently push a huge
// number of input tokens at the model.
//
// chars → tokens uses the common ~4-chars-per-token heuristic; it is a rough
// estimate, not an exact count. The meter is fed the raw bytes that the terminal
// forwards to the PTY, so it sees keystrokes and pastes alike.

import { useEffect, useReducer } from 'react'

const CHARS_PER_TOKEN = 4

const pending = new Map<string, number>()
const subs = new Map<string, Set<() => void>>()

function emit(id: string): void {
  const s = subs.get(id)
  if (s) for (const cb of s) cb()
}

/**
 * Feed raw input bytes sent to a session's PTY. A lone carriage-return/newline is
 * the user submitting the current prompt (resets the counter); a lone
 * backspace/DEL decrements it. Any other chunk — including a large multi-line
 * paste, whose internal newlines are part of the blob, not a submit — is added in
 * full. This keeps a rehydration paste measured as one large pending input.
 */
export function meterInput(id: string, data: string): void {
  if (data === '\r' || data === '\n' || data === '\r\n') {
    if (pending.get(id)) {
      pending.set(id, 0)
      emit(id)
    }
    return
  }
  let n = pending.get(id) ?? 0
  if (data === '\x7f' || data === '\b') n = n > 0 ? n - 1 : 0
  else n += data.length
  pending.set(id, n)
  emit(id)
}

/** Estimated tokens sitting unsent in the session's current prompt. */
export function pendingInputTokens(id: string): number {
  return Math.round((pending.get(id) ?? 0) / CHARS_PER_TOKEN)
}

/** Drop a session's meter (call on session close). */
export function clearInputMeter(id: string): void {
  const had = pending.delete(id)
  subs.delete(id)
  if (had) emit(id)
}

function subscribe(id: string, cb: () => void): () => void {
  let s = subs.get(id)
  if (!s) {
    s = new Set()
    subs.set(id, s)
  }
  s.add(cb)
  return () => {
    const set = subs.get(id)
    if (set) {
      set.delete(cb)
      if (set.size === 0) subs.delete(id)
    }
  }
}

/** React binding: the live estimated pending-input tokens for a session. */
export function usePendingInputTokens(id: string): number {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribe(id, bump), [id])
  return pendingInputTokens(id)
}
