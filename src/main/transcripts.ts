// Opt-in local transcript capture. Writes each session's ANSI-stripped output to
// <userData>/transcripts/<id>.log, buffered and flushed on a timer. Used for
// search + export. Privacy: only runs when the user enables it; stays on disk,
// never leaves the machine.

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface TranscriptMatch {
  sessionId: string
  lineNo: number
  line: string
}

const FLUSH_MS = 1500
const MAX_MATCHES = 300

export class TranscriptRecorder {
  private readonly buffers = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best-effort */
    }
  }

  append(id: string, text: string): void {
    if (!text) return
    this.buffers.set(id, (this.buffers.get(id) ?? '') + text)
    if (!this.timer) this.timer = setInterval(() => this.flush(), FLUSH_MS)
  }

  flush(): void {
    for (const [id, text] of this.buffers) {
      if (!text) continue
      try {
        appendFileSync(join(this.dir, `${id}.log`), text)
      } catch {
        /* best-effort */
      }
      this.buffers.set(id, '')
    }
  }

  read(id: string): string {
    this.flush()
    try {
      return readFileSync(join(this.dir, `${id}.log`), 'utf8')
    } catch {
      return ''
    }
  }

  search(query: string): TranscriptMatch[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    this.flush()
    const out: TranscriptMatch[] = []
    let files: string[] = []
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.log'))
    } catch {
      return []
    }
    for (const f of files) {
      const id = f.slice(0, -4)
      let lines: string[] = []
      try {
        lines = readFileSync(join(this.dir, f), 'utf8').split('\n')
      } catch {
        continue
      }
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          out.push({ sessionId: id, lineNo: i + 1, line: lines[i].slice(0, 300).trim() })
          if (out.length >= MAX_MATCHES) return out
        }
      }
    }
    return out
  }

  dispose(): void {
    this.flush()
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
