// Pure, dependency-free OSC (Operating System Command) parser. Extracts the
// SEMANTIC marks Crew cares about — OSC 133/633 command lifecycle, OSC 9
// notifications, OSC 7 cwd — from a raw PTY byte stream. Kept free of DOM /
// xterm / node imports (like detection.ts) so it is unit-testable in plain Node
// and reusable in both the renderer (block UI) and main (detection) processes.
//
// OSC framing: ESC ] Ps ; Pt (BEL | ESC \). Sequences can arrive split across
// PTY chunks, so this is a small streaming state machine that retains a partial
// trailing sequence between push() calls.

export type OscKind =
  | 'prompt-start' // 133;A / 633;A  — shell about to draw its prompt
  | 'input-start' //  133;B / 633;B  — prompt end; user input begins
  | 'output-start' // 133;C / 633;C  — command started running
  | 'command-end' //  133;D / 633;D  — command finished (with exit code)
  | 'command-text' // 633;E          — the command line text
  | 'notify' //       9;<text>       — desktop notification
  | 'cwd' //          7;file://…      — working directory report

export interface OscEvent {
  kind: OscKind
  exitCode?: number
  cwd?: string
  data?: string
}

function parseOsc(ps: string, pt: string): OscEvent | null {
  if (ps === '133' || ps === '633') {
    const semi = pt.indexOf(';')
    const sub = semi >= 0 ? pt.slice(0, semi) : pt
    const rest = semi >= 0 ? pt.slice(semi + 1) : ''
    switch (sub) {
      case 'A':
        return { kind: 'prompt-start' }
      case 'B':
        return { kind: 'input-start' }
      case 'C':
        return { kind: 'output-start' }
      case 'D': {
        const code = rest.length ? Number(rest.split(';')[0]) : undefined
        return {
          kind: 'command-end',
          exitCode: Number.isFinite(code as number) ? (code as number) : undefined
        }
      }
      case 'E':
        return { kind: 'command-text', data: rest }
      default:
        return null
    }
  }
  if (ps === '9') {
    // OSC 9;4;… is the progress protocol — not a notification. Ignore in v1.
    if (pt.startsWith('4;')) return null
    return { kind: 'notify', data: pt }
  }
  if (ps === '7') {
    const cwd = fileUriToPath(pt)
    return cwd ? { kind: 'cwd', cwd } : null
  }
  return null
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  const rest = uri.slice('file://'.length)
  const slash = rest.indexOf('/')
  const path = slash >= 0 ? rest.slice(slash) : rest
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export class OscParser {
  private buf = ''
  // Cap the retained partial buffer so a stray, unterminated ESC] can't grow
  // memory without bound. 4096 comfortably fits any real OSC 8/633 payload.
  private static readonly MAX = 4096
  // ESC ] Ps ; Pt (BEL | ESC \). Non-greedy Pt; tolerant of embedded newlines.
  private static readonly SEQ = /\u001b\]([0-9]+);([\s\S]*?)(?:\u0007|\u001b\\)/g

  /** Feed the next PTY chunk; returns any complete semantic marks found. */
  push(chunk: string): OscEvent[] {
    this.buf += chunk
    const events: OscEvent[] = []
    const re = OscParser.SEQ
    re.lastIndex = 0
    let lastEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(this.buf)) !== null) {
      const ev = parseOsc(m[1], m[2])
      if (ev) events.push(ev)
      lastEnd = re.lastIndex
    }
    // Retain only a possibly-incomplete trailing OSC (from the last ESC] at or
    // after the end of the last complete match); discard consumed/plain text.
    const tailStart = this.buf.indexOf('\u001b]', lastEnd)
    this.buf = tailStart >= 0 ? this.buf.slice(tailStart) : ''
    if (this.buf.length > OscParser.MAX) this.buf = this.buf.slice(-OscParser.MAX)
    return events
  }
}
