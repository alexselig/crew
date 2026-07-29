// Pure, DOM-free parser that turns a Copilot CLI session event log
// (~/.copilot/session-state/<agentSessionId>/events.jsonl) into the typed
// Transcript block stream the renderer already knows how to draw. This is the
// high-fidelity source for the Transcript view: the agent's own structured
// record of the conversation (prompts, prose, reasoning, tool runs, permission
// prompts, and rendered images) — far cleaner than scraping the TUI.
//
// Kept in src/shared (no fs, no DOM) so it is unit-testable under vitest and can
// run in the main process. The main-side reader (src/main/agent-transcript.ts)
// handles locating + reading the file; this module only parses text → blocks.
//
// The block shapes intentionally mirror src/renderer/transcript/types.ts so the
// renderer can consume the IPC result directly as TranscriptBlock[]. A
// compile-time assignability check in TranscriptPane guards against drift.

export interface AgentUserBlock {
  kind: 'user'
  id: string
  text: string
  ts?: number
}
export interface AgentTextBlock {
  kind: 'agent'
  id: string
  text: string
  ts?: number
}
export interface AgentThinkingBlock {
  kind: 'thinking'
  id: string
  body: string
  durationMs?: number
  ts?: number
}
export interface AgentToolBlock {
  kind: 'tool'
  id: string
  command: string
  output?: string
  exitCode?: number
  durationMs?: number
  ts?: number
}
export interface AgentImageBlock {
  kind: 'image'
  id: string
  src: string
  alt?: string
  caption?: string
  ts?: number
}
export interface AgentPermissionBlock {
  kind: 'permission'
  id: string
  command: string
  actor?: string
  resolution?: 'deny' | 'once' | 'always'
  ts?: number
}

export type AgentBlock =
  | AgentUserBlock
  | AgentTextBlock
  | AgentThinkingBlock
  | AgentToolBlock
  | AgentImageBlock
  | AgentPermissionBlock

/** Result of a versioned transcript read. `blocks` is null when the caller's
 *  `knownVersion` still matches (nothing changed), so an idle poll transfers
 *  only the small version token instead of the full (image-heavy) block list. */
export interface AgentTranscriptResult {
  /** Opaque version token (source file mtime+size). */
  version: string
  /** Parsed blocks, or null when unchanged since the caller's knownVersion. */
  blocks: AgentBlock[] | null
}

export interface ParseOptions {
  /** Keep only the most recent N blocks (default 600). */
  maxBlocks?: number
  /** Truncate any single text/output field to this many chars (default 8000). */
  maxText?: number
  /** Total base64 budget for inlined images, in bytes (default 16 MiB). Beyond
   *  this, images fall back to a file:// path when one is known, else are
   *  dropped. Newest images are prioritised for inlining. */
  maxInlineImageBytes?: number
  /** Skip inlining any single image whose raw byteLength exceeds this
   *  (default 4 MiB); a file:// fallback is used when available. */
  maxSingleImageBytes?: number
}

const DEFAULTS: Required<ParseOptions> = {
  maxBlocks: 600,
  maxText: 8000,
  maxInlineImageBytes: 16 * 1024 * 1024,
  maxSingleImageBytes: 4 * 1024 * 1024
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

// ── safe accessors (avoid `any`; the log is external, so narrow defensively) ──
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function str(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k]
  return typeof v === 'string' ? v : undefined
}
function num(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function rec(o: Record<string, unknown>, k: string): Record<string, unknown> | undefined {
  const v = o[k]
  return isRecord(v) ? v : undefined
}
function list(o: Record<string, unknown>, k: string): Record<string, unknown>[] {
  const v = o[k]
  return Array.isArray(v) ? v.filter(isRecord) : []
}

function toTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) return p
  }
  return undefined
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n… (${s.length - n} more chars)`
}

/** Parse "Image file at path /tmp/x.png" → "/tmp/x.png". */
function pathFromDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined
  const m = desc.match(/at path\s+(.+?)\s*$/i)
  const p = m ? m[1] : desc
  return IMAGE_EXT.test(p) ? p : undefined
}

function baseName(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

/** A short, human label for a tool run from its name + arguments. */
function toolLabel(toolName: string | undefined, args: Record<string, unknown> | undefined): string {
  const name = toolName || 'tool'
  if (args) {
    const command = str(args, 'command')
    if (command) return command
    const target =
      str(args, 'path') ||
      str(args, 'pattern') ||
      str(args, 'query') ||
      str(args, 'url') ||
      str(args, 'filePath') ||
      str(args, 'description')
    if (target) return `${name} ${target}`
  }
  return name
}

interface ImageAsset {
  mimeType: string
  data?: string
  byteLength?: number
  path?: string
}

/**
 * Turn Copilot CLI events.jsonl text into transcript blocks, in chronological
 * order. Unknown/invalid lines are skipped; the parser never throws on
 * malformed input.
 */
export function parseCopilotEvents(text: string, opts?: ParseOptions): AgentBlock[] {
  const o = { ...DEFAULTS, ...(opts ?? {}) }
  const lines = text.split('\n')

  // Pass 1: index binary image assets by assetId (the bytes live in
  // session.binary_asset; tool results reference them by id).
  const assets = new Map<string, ImageAsset>()
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.indexOf('binary_asset') === -1) continue
    let ev: unknown
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    if (!isRecord(ev) || ev['type'] !== 'session.binary_asset') continue
    const d = rec(ev, 'data')
    if (!d) continue
    const mimeType = str(d, 'mimeType') ?? ''
    if (!mimeType.startsWith('image/')) continue
    const assetId = str(d, 'assetId')
    if (!assetId) continue
    assets.set(assetId, {
      mimeType,
      data: str(d, 'data'),
      byteLength: num(d, 'byteLength'),
      path: pathFromDescription(str(d, 'description'))
    })
  }

  // Pass 2: build blocks in order.
  const blocks: AgentBlock[] = []
  const toolById = new Map<string, AgentToolBlock>()
  const permById = new Map<string, AgentPermissionBlock>()
  const emittedAssets = new Set<string>()
  const emittedSrc = new Set<string>()
  let inlineBudget = o.maxInlineImageBytes

  const srcForAsset = (a: ImageAsset): string | undefined => {
    const b = a.byteLength ?? (a.data ? Math.floor((a.data.length * 3) / 4) : 0)
    if (a.data && b <= o.maxSingleImageBytes && b <= inlineBudget) {
      inlineBudget -= b
      return `data:${a.mimeType};base64,${a.data}`
    }
    if (a.path) return `file://${a.path}`
    return undefined
  }

  const pushImage = (src: string, caption: string | undefined, ts: number | undefined, id: string): void => {
    if (emittedSrc.has(src)) return
    emittedSrc.add(src)
    blocks.push({ kind: 'image', id, src, alt: caption, caption, ts })
  }

  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    let ev: unknown
    try {
      ev = JSON.parse(t)
    } catch {
      continue
    }
    if (!isRecord(ev)) continue
    const type = str(ev, 'type')
    const id = str(ev, 'id') ?? `e${blocks.length}`
    const ts = toTs(ev['timestamp'])
    const d = rec(ev, 'data') ?? {}

    switch (type) {
      case 'user.message': {
        const text = (str(d, 'content') ?? '').trim()
        if (text) blocks.push({ kind: 'user', id: `u:${id}`, text: clip(text, o.maxText), ts })
        // Inline any image attachments the human sent.
        for (const att of list(d, 'attachments')) {
          const p = str(att, 'path')
          if (p && IMAGE_EXT.test(p)) {
            pushImage(`file://${p}`, str(att, 'displayName') ?? baseName(p), ts, `att:${id}:${p}`)
          }
        }
        break
      }
      case 'assistant.message': {
        const reasoning = (str(d, 'reasoningText') ?? '').trim()
        if (reasoning) {
          blocks.push({ kind: 'thinking', id: `t:${id}`, body: clip(reasoning, o.maxText), ts })
        }
        const content = (str(d, 'content') ?? '').trim()
        if (content) blocks.push({ kind: 'agent', id: `a:${id}`, text: clip(content, o.maxText), ts })
        break
      }
      case 'tool.execution_start': {
        const callId = str(d, 'toolCallId')
        if (!callId) break
        const block: AgentToolBlock = {
          kind: 'tool',
          id: `tool:${callId}`,
          command: clip(toolLabel(str(d, 'toolName'), rec(d, 'arguments')), 400),
          ts
        }
        toolById.set(callId, block)
        blocks.push(block)
        break
      }
      case 'tool.execution_complete': {
        const callId = str(d, 'toolCallId')
        const block = callId ? toolById.get(callId) : undefined
        const result = rec(d, 'result')
        if (block) {
          block.exitCode = d['success'] === false ? 1 : 0
          const out = result ? str(result, 'content') : undefined
          if (out) block.output = clip(out.trim(), o.maxText)
          if (ts && block.ts) block.durationMs = Math.max(0, ts - block.ts)
        }
        // Inline any images the tool returned to the agent.
        if (result) {
          for (const bin of list(result, 'binaryResultsForLlm')) {
            if ((str(bin, 'mimeType') ?? '').startsWith('image/') === false) continue
            const assetId = str(bin, 'assetId')
            if (!assetId || emittedAssets.has(assetId)) continue
            const asset = assets.get(assetId)
            if (!asset) continue
            emittedAssets.add(assetId)
            const src = srcForAsset(asset)
            if (src) {
              const caption = asset.path ? baseName(asset.path) : str(bin, 'description')
              pushImage(src, caption, ts, `img:${assetId}`)
            }
          }
        }
        break
      }
      case 'permission.requested': {
        const pr = rec(d, 'permissionRequest') ?? rec(d, 'promptRequest')
        const requestId = str(d, 'requestId')
        const callId = pr ? str(pr, 'toolCallId') : undefined
        const key = requestId ?? callId
        if (!key) break
        const block: AgentPermissionBlock = {
          kind: 'permission',
          id: `perm:${key}`,
          command: clip((pr && (str(pr, 'intention') || str(pr, 'url'))) || 'permission request', 400),
          ts
        }
        permById.set(key, block)
        if (callId && callId !== key) permById.set(callId, block)
        blocks.push(block)
        break
      }
      case 'permission.completed': {
        const key = str(d, 'requestId') ?? str(d, 'toolCallId')
        const block = key ? permById.get(key) : undefined
        if (block) {
          const kind = (rec(d, 'result') && str(rec(d, 'result') as Record<string, unknown>, 'kind')) || ''
          block.resolution = /den|reject|no/i.test(kind) ? 'deny' : /always/i.test(kind) ? 'always' : 'once'
        }
        break
      }
      default:
        break
    }
  }

  return blocks.length > o.maxBlocks ? blocks.slice(blocks.length - o.maxBlocks) : blocks
}
