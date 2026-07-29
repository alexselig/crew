// Main-process reader that turns a Copilot CLI session's event log into typed
// Transcript blocks for the renderer's Transcript view. It locates + reads the
// file and resolves images to renderable data: URIs; the pure parser
// (src/shared/agent-events.ts) does the event→block mapping so it stays
// unit-testable and DOM/fs-free.
//
// The renderer polls this (via IPC) while the Transcript pane is open, so results
// are cached by (mtime,size): a poll that finds no change returns the cached
// blocks without re-reading. events.jsonl is append-only and can reach tens of
// MB (inlined image assets), so an over-large file is tail-read to bound cost.
//
// Images: the renderer CSP allows `data:` (not `file://`), so any image the
// parser could only reference by path (e.g. a human's attachment) is inlined
// here as a size-capped data: URI. Agent-produced images already carry their
// bytes in the log and are inlined by the parser.

import { readFile, stat, open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { parseCopilotEvents, type AgentBlock, type AgentTranscriptResult } from '../shared/agent-events'

const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state')
// Cap the bytes we ingest per read; beyond this we read only the tail (dropping
// the earliest blocks/images) so a very long session can't stall the main thread.
const MAX_BYTES = 64 * 1024 * 1024
// Bound the per-session cache so long-lived apps don't accumulate entries.
const MAX_CACHE = 64
// Budget for images inlined from disk here (path-only images, e.g. attachments),
// newest-first; keeps the IPC payload bounded.
const IMG_TOTAL_BUDGET = 6 * 1024 * 1024
const IMG_SINGLE_MAX = 3 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

interface CacheEntry {
  version: string
  blocks: AgentBlock[]
}

const cache = new Map<string, CacheEntry>()

async function readTail(file: string, size: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const start = Math.max(0, size - MAX_BYTES)
    const len = size - start
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, start)
    let text = buf.toString('utf8')
    // Drop a partial first line so the parser never sees a truncated record.
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    return text
  } finally {
    await fh.close()
  }
}

/** Inline any `file://` image block as a data: URI (CSP forbids file://), newest
 *  first within a byte budget; drop images that are missing, too large, or over
 *  budget. Returns a filtered block list. */
async function resolveImages(blocks: AgentBlock[]): Promise<AgentBlock[]> {
  let budget = IMG_TOTAL_BUDGET
  const drop = new Set<AgentBlock>()
  // Newest images first so the most recent screenshots always make the budget.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind !== 'image' || !b.src.startsWith('file://')) continue
    const path = decodeURIComponent(b.src.slice('file://'.length))
    const mime = MIME[extname(path).toLowerCase()]
    if (!mime) {
      drop.add(b)
      continue
    }
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size > IMG_SINGLE_MAX || st.size > budget) {
        drop.add(b)
        continue
      }
      const bytes = await readFile(path)
      budget -= st.size
      b.src = `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      drop.add(b)
    }
  }
  return drop.size ? blocks.filter((b) => !drop.has(b)) : blocks
}

/**
 * Versioned transcript read for a Copilot CLI session. When `knownVersion`
 * matches the current source (mtime+size), returns `{ version, blocks: null }`
 * so an idle poll transfers only the token — not the full (image-heavy) list.
 * Otherwise parses and returns the blocks, newest-last. Returns an empty
 * `blocks: []` for a missing agent id, a session with no event log
 * (shell/Claude sessions), or any read/parse error — the caller then falls back
 * to the terminal-derived transcript.
 */
export async function readAgentTranscript(
  agentSessionId: string | null | undefined,
  knownVersion?: string
): Promise<AgentTranscriptResult> {
  // Guard the path segment (ids are UUIDs) against traversal.
  if (!agentSessionId || !/^[A-Za-z0-9._-]+$/.test(agentSessionId)) return { version: '', blocks: [] }
  const file = join(SESSION_STATE_DIR, agentSessionId, 'events.jsonl')
  try {
    const st = await stat(file)
    const version = `${st.mtimeMs}:${st.size}`
    // Caller is already up to date — send nothing but the token.
    if (knownVersion && knownVersion === version) return { version, blocks: null }

    const cached = cache.get(agentSessionId)
    if (cached && cached.version === version) return { version, blocks: cached.blocks }

    const text = st.size > MAX_BYTES ? await readTail(file, st.size) : await readFile(file, 'utf8')
    const blocks = await resolveImages(
      parseCopilotEvents(text, { maxInlineImageBytes: IMG_TOTAL_BUDGET, maxSingleImageBytes: IMG_SINGLE_MAX })
    )

    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(agentSessionId, { version, blocks })
    return { version, blocks }
  } catch {
    return { version: '', blocks: [] }
  }
}
