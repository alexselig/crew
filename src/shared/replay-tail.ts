// Keeping a bounded replay tail from cutting an escape sequence in half.
//
// A retired session is rebuilt by replaying its last TAIL_LIMIT code units. That
// bound has to fall somewhere, and if it falls *inside* an escape sequence the
// surviving half is no longer an instruction — it is text. `ESC[38;2;145;152;161m`
// cut after `ESC[38;` replays as a literal `2;145;152;161m` in the middle of the
// session, which is what the artifact looks like on screen.
//
// The same hazard already has a guard one level down for surrogate pairs; this is
// the same idea for escapes. It cannot be done by inspecting the surviving half
// alone, because `2;145;152;161m` is also perfectly ordinary text. So it is
// decided by what was *discarded*: if the discarded run ends part-way through a
// sequence, then whatever now begins the tail is that sequence's continuation and
// must go with it.
//
// Pure so it can be tested without a DOM or an emulator.

const ESC = '\u001b'

/** The kind of escape sequence left open, which decides how it terminates. */
export type OpenEscape = 'csi' | 'osc' | 'esc'

/**
 * The sequence left unterminated at the end of `discarded`, or null when it ends
 * cleanly. Only the last `window` code units are examined: a sequence is short,
 * and the discarded run can be the better part of a megabyte.
 */
export function openEscapeAt(discarded: string, window = 4096): OpenEscape | null {
  if (!discarded) return null
  const w = discarded.length > window ? discarded.slice(-window) : discarded
  const i = w.lastIndexOf(ESC)
  if (i < 0) return null
  // ESC as the very last unit: the next unit decides what it becomes.
  if (i === w.length - 1) return 'esc'
  const next = w[i + 1]
  if (next === '[') {
    // CSI ends at a final byte in @-~; parameters and intermediates sort below it.
    for (let j = i + 2; j < w.length; j++) {
      const c = w.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) return null
    }
    return 'csi'
  }
  if (next === ']') {
    // OSC ends at BEL or ST.
    for (let j = i + 2; j < w.length; j++) {
      if (w[j] === '\u0007') return null
      if (w[j] === ESC && w[j + 1] === '\\') return null
    }
    return 'osc'
  }
  // Anything else is a two-unit escape, already whole.
  return null
}

/**
 * How much of `head` belongs to an interrupted sequence of this `kind`, or -1
 * when the terminator is not in `head` at all and the next part must be consumed
 * too.
 */
export function orphanLength(kind: OpenEscape, head: string): number {
  if (!head) return -1
  if (kind === 'esc') return 1
  if (kind === 'csi') {
    for (let j = 0; j < head.length; j++) {
      const c = head.charCodeAt(j)
      if (c >= 0x40 && c <= 0x7e) return j + 1
    }
    return -1
  }
  for (let j = 0; j < head.length; j++) {
    if (head[j] === '\u0007') return j + 1
    if (head[j] === ESC && head[j + 1] === '\\') return j + 2
  }
  return -1
}
