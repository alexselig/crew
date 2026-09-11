// Opt-in local transcript capture. Writes each session's ANSI-stripped output to
// <userData>/transcripts/<id>.log, buffered and flushed on a timer. Used for
// search + export. Privacy: only runs when the user enables it; stays on disk,
// never leaves the machine.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { syncParentDirectory } from './atomic-file'

export interface TranscriptMatch {
  sessionId: string
  lineNo: number
  line: string
}

const FLUSH_MS = 1500
const MAX_MATCHES = 300
const MAX_PENDING_BYTES = 256 * 1024

interface PendingTranscript {
  chunks: Buffer[]
  chunkIndex: number
  offset: number
  bytes: number
  blocked: boolean
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}

/** Callers supply opt-in, ANSI-stripped output, not a lossless raw PTY archive.
 * Pause the matching PTY on blocked(id), resume it on drained(id). Without that
 * integration, an ongoing storage failure can still grow the pending queue. */
export class TranscriptRecorder extends EventEmitter<{ blocked: [sessionId: string]; drained: [sessionId: string] }> {
  private readonly buffers = new Map<string, PendingTranscript>()
  private pendingBytes = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(private readonly dir: string, private readonly onError?: (message: string) => void) {
    super()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      this.report('failed to create transcript directory', err)
    }
  }

  append(id: string, text: string): void {
    if (!text || !this.validId(id)) return
    const bytes = Buffer.from(text, 'utf8')
    const pending = this.buffers.get(id) ?? { chunks: [], chunkIndex: 0, offset: 0, bytes: 0, blocked: false }
    pending.chunks.push(bytes)
    pending.bytes += bytes.length
    this.pendingBytes += bytes.length
    this.buffers.set(id, pending)
    if (this.pendingBytes >= MAX_PENDING_BYTES) this.flush()
    if (this.buffers.size > 0 && !this.timer) {
      this.timer = setInterval(() => this.flush(), FLUSH_MS)
      this.timer.unref()
    }
  }

  flush(): void {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const [id, pending] of this.buffers) {
        let fd: number | undefined
        let durable = false
        try {
          mkdirSync(this.dir, { recursive: true })
          const path = join(this.dir, `${id}.log`)
          fd = openSync(path, 'a', 0o600)
          while (pending.chunkIndex < pending.chunks.length) {
            const chunk = pending.chunks[pending.chunkIndex]
            const written = writeSync(fd, chunk, pending.offset, chunk.length - pending.offset, null)
            if (written <= 0) throw new Error('transcript write made no progress')
            pending.offset += written
            if (pending.offset === chunk.length) {
              pending.chunkIndex++
              pending.offset = 0
            }
          }
          // Keep the byte cursor even when fsync fails: retry the sync, not the
          // already-appended bytes. Buffers are released only after durability.
          fsyncSync(fd)
          syncParentDirectory(path)
          durable = true
        } catch (err) {
          if (!pending.blocked) {
            pending.blocked = true
            this.emit('blocked', id)
            this.report(`transcript capture blocked for ${id}; pending output retained`, err)
          } else {
            console.warn(`[crew] transcript flush still blocked for ${id}:`, err)
          }
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd)
            } catch (err) {
              this.report(`failed to close transcript for ${id}`, err)
            }
          }
        }
        if (durable) {
          this.pendingBytes -= pending.bytes
          this.buffers.delete(id)
          if (pending.blocked) this.emit('drained', id)
        }
      }
    } finally {
      this.flushing = false
      if (this.buffers.size === 0) this.stopTimer()
    }
  }

  read(id: string): string {
    if (!this.validId(id)) return ''
    this.flush()
    try {
      return readFileSync(join(this.dir, `${id}.log`), 'utf8')
    } catch (err) {
      if (!isMissing(err)) this.report(`failed to read transcript for ${id}`, err)
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
    } catch (err) {
      if (!isMissing(err)) this.report('failed to search transcript directory', err)
      return []
    }
    for (const f of files) {
      const id = f.slice(0, -4)
      if (!this.validId(id)) continue
      let lines: string[] = []
      try {
        lines = readFileSync(join(this.dir, f), 'utf8').split('\n')
      } catch (err) {
        if (!isMissing(err)) this.report(`failed to search transcript for ${id}`, err)
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
    this.stopTimer()
    // A failed final flush deliberately keeps pending bytes. The owner can
    // explicitly flush again; shutting down the process still loses that memory.
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private validId(id: string): boolean {
    if (/^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 200) return true
    this.report('invalid transcript session ID; expected 1-200 letters, digits, underscores or hyphens')
    return false
  }

  private report(message: string, err?: unknown): void {
    const detail = err === undefined ? message : `${message}: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[crew] ${detail}`)
    try {
      this.onError?.(detail)
    } catch (callbackError) {
      console.warn('[crew] transcript error callback failed:', callbackError)
    }
  }
}
