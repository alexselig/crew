/**
 * Clickable things in terminal output.
 *
 * Two kinds of link exist in a session. OSC 8 hyperlinks carry their target as
 * an escape sequence and xterm resolves them itself; nothing here touches those.
 * Everything else is just printed text, and a CLI that prints a bare URL gives
 * the terminal no way to know it is a link — so we detect those ourselves.
 *
 * Detection runs on a *logical* line: a URL long enough to fill the pane wraps
 * onto the next row, and a per-row scan would see two halves and match neither.
 */

import { findAssetPaths, type PathMatch } from './assets'

export type { PathMatch }

// A bare URL as printed. Stops at whitespace and at the bracket/quote
// characters that normally surround a URL rather than belong to it.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`()[\]{}\\^|]+/gi

// Trailing punctuation that is almost always sentence punctuation, not part of
// the address: "see https://x.dev/docs." should not link the full stop.
const TRAILING_PUNCT = /[.,;:!?'"]+$/

const MAX_MATCHES_PER_LINE = 20

/** True for a token this module would open in a browser rather than preview. */
export function isUrlToken(text: string): boolean {
  return /^(?:https?:\/\/|www\.)/i.test(text)
}

/** The address to actually open for a matched token. */
export function normalizeUrl(text: string): string {
  return /^https?:\/\//i.test(text) ? text : 'https://' + text
}

/** Find bare URLs in one logical line of terminal output. */
export function findUrls(line: string): PathMatch[] {
  const out: PathMatch[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(line)) && out.length < MAX_MATCHES_PER_LINE) {
    let text = m[0].replace(TRAILING_PUNCT, '')
    // A closing bracket only counts as part of the URL if it was opened inside
    // it; the regex already excludes brackets, so a trailing one is noise.
    text = text.replace(/[)\]}>]+$/, '')
    // An explicit scheme is evidence enough, and must be: the links agents print
    // most are http://localhost:3000 and http://127.0.0.1:5173, which have no
    // dotted TLD at all. Without a scheme, insist on a www host with a real TLD
    // so ordinary prose ("pool.ts") is never underlined.
    const scheme = /^https?:\/\//i.exec(text)
    if (scheme) {
      if (!/^[\w.-]/.test(text.slice(scheme[0].length))) continue
    } else if (!/^www\.[^.\s]+\.[a-z]{2,}/i.test(text)) continue
    out.push({ text, start: m.index, end: m.index + text.length })
  }
  return out
}

/**
 * Every clickable token in one logical line: bare URLs plus previewable file
 * paths. Asset paths that sit inside a URL are dropped, so "https://x/a.png"
 * opens the page rather than trying to preview a file that is not on disk.
 */
export function findTerminalLinks(line: string): PathMatch[] {
  const urls = findUrls(line)
  const paths = findAssetPaths(line).filter(
    (p) => !urls.some((u) => p.start < u.end && u.start < p.end)
  )
  return [...urls, ...paths].sort((a, b) => a.start - b.start)
}

/** One row of a terminal buffer, as much of it as link detection needs. */
export interface BufferLineLike {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

/** The buffer surface link detection reads. */
export interface BufferLike {
  length: number
  getLine(y: number): BufferLineLike | undefined
}

/** A group of buffer rows that together form one logical line. */
export interface WrappedGroup {
  /** 0-based buffer row the logical line starts on. */
  firstRow: number
  /** The logical line, each row padded to the full width so offsets map back. */
  text: string
}

/** Rows joined for one logical line; bounds the walk so a pathological buffer
 * of wrapped rows can't make a hover scan the whole scrollback. */
export const MAX_WRAPPED_ROWS = 12

/**
 * Reassemble the logical line that buffer row `row` belongs to. Rows are taken
 * untrimmed so every row contributes exactly `cols` characters and a match
 * offset divides cleanly back into a row and a column.
 */
export function wrappedGroupAt(buf: BufferLike, row: number): WrappedGroup | undefined {
  if (row < 0 || row >= buf.length || !buf.getLine(row)) return undefined
  let first = row
  while (first > 0 && buf.getLine(first)?.isWrapped && row - first < MAX_WRAPPED_ROWS) first--
  const parts: string[] = []
  for (let y = first; y < buf.length && parts.length < MAX_WRAPPED_ROWS; y++) {
    const line = buf.getLine(y)
    if (!line) break
    if (y > first && !line.isWrapped) break
    parts.push(line.translateToString(false))
  }
  if (!parts.length) return undefined
  return { firstRow: first, text: parts.join('') }
}

/** An xterm link range: 1-based rows and columns, inclusive end column. */
export interface LinkRange {
  start: { x: number; y: number }
  end: { x: number; y: number }
}

/**
 * Map a half-open offset range in a logical line onto xterm buffer
 * coordinates, which are 1-based and have an inclusive end column.
 */
export function rangeForMatch(
  start: number,
  end: number,
  cols: number,
  firstRow: number
): LinkRange {
  const last = Math.max(start, end - 1)
  return {
    start: { x: (start % cols) + 1, y: firstRow + Math.floor(start / cols) + 1 },
    end: { x: (last % cols) + 1, y: firstRow + Math.floor(last / cols) + 1 }
  }
}
