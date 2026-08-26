// Plain-text preview of a terminal's recent output, for tiles that do not have
// (or do not deserve) a live emulator.
//
// A grid of sixty sessions cannot afford sixty terminal emulators: each one
// parses, buffers and repaints continuously because agents stream output even
// when idle. Off-screen tiles therefore render this instead — the last few lines
// as inert text, which costs a string and a <pre>.
//
// Pure so it can be tested without a DOM or an emulator.

// CSI / OSC / single-character escapes. Terminal output is dense with these and
// they must not leak into the preview as mojibake.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g

/**
 * The last `maxLines` non-empty lines of raw terminal output, stripped of escape
 * sequences. Carriage returns are treated as line rewrites (a progress bar that
 * redraws with \r should read as its final state, not as hundreds of lines).
 */
export function previewLines(raw: string, maxLines = 12): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const chunk of raw.split('\n')) {
    // \r rewrites the current line in a real terminal; keep only the last write.
    const line = chunk.slice(chunk.lastIndexOf('\r') + 1).replace(ANSI, '').trimEnd()
    if (line.trim()) out.push(line)
  }
  return out.slice(-maxLines)
}
