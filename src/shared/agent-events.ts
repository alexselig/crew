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
//
// READING AN UNSPECIFIED FORMAT. GitHub documents that session data lives in
// ~/.copilot/session-state, but documents no field of it and promises no
// stability; the CLI's bundled schemas/session-events.schema.json is the closest
// thing to a contract, and the CLI is known to violate it. So this parser treats
// every field as optional, ignores unknown event types, and is written against
// these known defects rather than against the happy path:
//
//   #4098 / #2649  the log is opened/appended/closed per event with no
//                  serialisation, so records get concatenated onto one line,
//                  cut in half, or written with raw unescaped newlines
//   #4269          assistant.message.content can be null despite being declared
//                  a required string
//   #3520 / #2000  events omit fields the schema marks required
//
// Anything unreadable costs its own block, never the rest of the file.

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

/**
 * Split a chunk into balanced top-level JSON objects, ignoring braces that sit
 * inside strings.
 *
 * The CLI opens/appends/closes the log per event with no serialisation, so
 * concurrent writers can concatenate two records onto one physical line or cut
 * one in half (github/copilot-cli#4098, #2649). A plain per-line JSON.parse
 * drops every event in that line — silently, and usually right where a session
 * got interesting. This recovers whatever is intact.
 */
function splitObjects(chunk: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      if (depth > 0) depth--
      if (depth === 0 && start >= 0) {
        out.push(chunk.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

/** Stop accumulating a malformed run once it exceeds this; beyond it we salvage
 *  what parses and move on rather than growing a string without bound. */
const MAX_PENDING = 4 * 1024 * 1024

/**
 * Escape raw control characters that appear inside JSON string literals.
 *
 * A tool result with embedded newlines can be written into the log unescaped
 * (github/copilot-cli#2649), which makes the record invalid JSON and splits it
 * across physical lines. Re-escaping recovers it; text outside strings is left
 * alone so this can never change a document's structure.
 */
function escapeRawControls(chunk: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      if (inStr && c.charCodeAt(0) < 0x20) {
        out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : ''
        continue
      }
    } else if (c === '"') inStr = true
    out += c
  }
  return out
}

/** Parse one record, repairing raw control characters if a strict parse fails.
 *  Returns null when nothing usable can be recovered. */
function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const ev: unknown = JSON.parse(raw)
    return isRecord(ev) ? ev : null
  } catch {
    /* try the repair below */
  }
  try {
    const ev: unknown = JSON.parse(escapeRawControls(raw))
    return isRecord(ev) ? ev : null
  } catch {
    return null
  }
}

/**
 * Walk a JSONL log, tolerating the malformed records the CLI is known to write.
 *
 * The intact-line path is unchanged (split + JSON.parse); recovery only costs
 * anything once a line has actually failed. `needle` lets a caller skip lines it
 * cannot care about without paying for a parse.
 */
function scanEvents(
  text: string,
  onEvent: (ev: Record<string, unknown>) => void,
  needle?: string
): void {
  let pending = ''
  let pendingDepth = 0
  let pendingInString = false
  let pendingEscape = false
  let pendingStarted = false

  const resetPendingState = (): void => {
    pendingDepth = 0
    pendingInString = false
    pendingEscape = false
    pendingStarted = false
  }

  const appendPending = (chunk: string): boolean => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (pendingInString) {
        if (pendingEscape) pendingEscape = false
        else if (c === '\\') pendingEscape = true
        else if (c === '"') pendingInString = false
        continue
      }
      if (c === '"') pendingInString = true
      else if (c === '{') {
        pendingStarted = true
        pendingDepth++
      } else if (c === '}' && pendingDepth > 0) {
        pendingDepth--
        if (pendingStarted && pendingDepth === 0) return true
      }
    }
    return false
  }

  const salvage = (): void => {
    if (!pending) return
    const buffered = pending
    pending = ''
    resetPendingState()
    for (const obj of splitObjects(buffered)) {
      const ev = tryParse(obj)
      if (ev) onEvent(ev)
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (!pending) {
      if (needle !== undefined && line.indexOf(needle) === -1) continue
      const ev = tryParse(line)
      if (ev) {
        onEvent(ev)
        continue
      }
      // Two or more balanced objects on one line: concatenated writes. Emitting
      // them straight away keeps a corrupt line from swallowing its neighbours.
      const parts = splitObjects(line)
      if (parts.length > 1) {
        for (const p of parts) {
          const part = tryParse(p)
          if (part) onEvent(part)
        }
        continue
      }
      pending = raw
      if (appendPending(raw)) salvage()
      continue
    }
    // Already recovering. A line that parses on its own is a new record, which
    // means what we buffered was unrecoverable garbage — salvage what we can
    // from it and carry on, rather than letting it swallow its neighbours.
    const standalone = tryParse(line)
    if (standalone) {
      salvage()
      onEvent(standalone)
      continue
    }
    pending += '\n' + raw
    if (appendPending('\n' + raw)) {
      const joined = tryParse(pending.trim())
      if (joined) onEvent(joined)
      else salvage()
      pending = ''
      resetPendingState()
    }
    if (pending.length > MAX_PENDING) salvage()
  }
  salvage()
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

  // Pass 1: index binary image assets by assetId (the bytes live in
  // session.binary_asset; tool results reference them by id).
  const assets = new Map<string, ImageAsset>()
  scanEvents(
    text,
    (ev) => {
      if (ev['type'] !== 'session.binary_asset') return
      const d = rec(ev, 'data')
      if (!d) return
      const mimeType = str(d, 'mimeType') ?? ''
      if (!mimeType.startsWith('image/')) return
      const assetId = str(d, 'assetId')
      if (!assetId) return
      assets.set(assetId, {
        mimeType,
        data: str(d, 'data')?.replace(/\s/g, ''),
        byteLength: num(d, 'byteLength'),
        path: pathFromDescription(str(d, 'description'))
      })
    },
    'binary_asset'
  )

  // Pass 2: build blocks in order.
  const blocks: AgentBlock[] = []
  const toolById = new Map<string, AgentToolBlock>()
  const permById = new Map<string, AgentPermissionBlock>()
  const agentByMessage = new Map<string, AgentTextBlock>()
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

  scanEvents(text, (ev) => {
    const type = str(ev, 'type')
    // The undeclared model.* family (a raw routing/debug trace, added in
    // 1.0.81-8) carries nothing we render, and model.messages_snapshot repeats
    // the whole conversation. Nothing below consumes it, so drop it early.
    if (type && type.startsWith('model.')) return
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
        // A long answer can arrive split across chunkCount records sharing one
        // messageId. Appending to the block we already emitted keeps it one
        // message instead of a run of fragments — and a chunk's edges must not
        // be trimmed, or the join eats the space between them.
        const raw = str(d, 'content') ?? ''
        const messageId = str(d, 'messageId')
        const chunked = messageId !== undefined && num(d, 'chunkCount') !== undefined
        const prior = chunked ? agentByMessage.get(messageId) : undefined
        if (prior) {
          prior.text = clip(prior.text + raw, o.maxText)
          break
        }
        const content = chunked ? raw.trimStart() : raw.trim()
        if (!content) break
        const block: AgentTextBlock = { kind: 'agent', id: `a:${id}`, text: clip(content, o.maxText), ts }
        if (chunked) agentByMessage.set(messageId, block)
        blocks.push(block)
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
          const failed = d['success'] === false
          block.exitCode = failed ? 1 : 0
          // `result` is only populated on success; a failure puts its message in
          // a sibling `error` object. Reading result.content alone rendered every
          // failed run as an empty block — exactly the run you need to read.
          // On success prefer `detailedContent`, the schema's display form: for
          // an edit that is the diff, where `content` is the whole new file.
          const out = failed
            ? str(rec(d, 'error') ?? {}, 'message')
            : result
              ? str(result, 'detailedContent') ?? str(result, 'content')
              : undefined
          if (out && out.trim()) block.output = clip(out.trim(), o.maxText)
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
          // Real vocabulary: approved | approved-for-location | denied-… .
          // "for-location" is the session-wide grant, i.e. always; nothing the
          // CLI writes contains the word "always", so matching on it alone
          // labelled every standing approval as a one-off.
          block.resolution = /den|reject/i.test(kind)
            ? 'deny'
            : /always|for-location|for-session/i.test(kind)
              ? 'always'
              : 'once'
        }
        break
      }
      default:
        break
    }
  })

  return blocks.length > o.maxBlocks ? blocks.slice(blocks.length - o.maxBlocks) : blocks
}
