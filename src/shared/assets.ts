// Pure asset-classification helpers shared by the main-process watcher and the
// renderer panel. No Node imports — unit-tested like detection.ts.

export type AssetKind = 'image' | 'html' | 'pdf' | 'video' | 'audio'

/** A previewable file found in (or created into) a session's working directory. */
export interface AssetItem {
  /** Absolute path on disk. */
  path: string
  /** Base filename. */
  name: string
  /** Directory relative to the session cwd ('' = the cwd itself). */
  relDir: string
  ext: string
  kind: AssetKind
  size: number
  mtime: number
}

const EXT_KIND: Record<string, AssetKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  svg: 'image',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio'
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4'
}

export function assetExt(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** null = not a previewable asset type. */
export function assetKind(name: string): AssetKind | null {
  return EXT_KIND[assetExt(name)] ?? null
}

export function assetMime(name: string): string {
  return EXT_MIME[assetExt(name)] ?? 'application/octet-stream'
}

/** Directories never worth scanning/watching for user-facing assets. */
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'venv',
  '__pycache__',
  'Library',
  'Applications'
])

/** True for directory names that should be skipped entirely (incl. dot-dirs). */
export function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(name)
}

/** True if any directory segment of a cwd-relative path is ignored. */
export function isIgnoredRelPath(rel: string): boolean {
  const segs = rel.split(/[\\/]/)
  // All but the last segment are directories; also reject dot-files themselves.
  for (let i = 0; i < segs.length - 1; i++) {
    if (isIgnoredDir(segs[i])) return true
  }
  const base = segs[segs.length - 1]
  return base.startsWith('.')
}

/** Renderer-side URL for the crew-asset:// protocol (served by main, allowlisted). */
export function assetUrl(path: string): string {
  return 'crew-asset://local/' + encodeURIComponent(path)
}

export interface PathMatch {
  /** The matched path token exactly as printed. */
  text: string
  /** 0-based start index (inclusive) in the line. */
  start: number
  /** 0-based end index (exclusive) in the line. */
  end: number
}

// A path-ish token ending in a previewable extension: absolute (/…), homedir
// (~/…), dotted (./ ../) or bare relative (a/b.png, shot.png). No spaces —
// quoted paths with spaces aren't worth the false positives.
const ASSET_PATH_RE =
  /(?:~\/|\.{1,2}\/|\/)?[\w@%+=.,-]+(?:\/[\w@%+=.,-]+)*\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|html?|pdf|mp4|webm|mov|mp3|wav|ogg|m4a)\b/gi

const MAX_MATCHES_PER_LINE = 20

/** Find previewable file-path tokens in one line of terminal output. */
export function findAssetPaths(line: string): PathMatch[] {
  const out: PathMatch[] = []
  ASSET_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ASSET_PATH_RE.exec(line)) && out.length < MAX_MATCHES_PER_LINE) {
    // Skip URL bodies ("https://site.com/a.png"): a match starting right after
    // '/' or ':' is the tail of a URL/longer token, not a filesystem path.
    const prev = m.index > 0 ? line[m.index - 1] : ''
    if (prev === '/' || prev === ':') continue
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  }
  return out
}
