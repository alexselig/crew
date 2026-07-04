// Per-session asset watcher: keeps a small "recently created/changed assets"
// list for each session's cwd (images, HTML, PDFs, …) so the renderer can show
// live previews. One recursive fs.watch per session, an initial bounded scan,
// and debounced change events. Also acts as the allowlist for crew-asset://.

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { assetKind, isIgnoredDir, isIgnoredRelPath, type AssetItem } from '../shared/assets'
import type { SessionInfo } from '../shared/types'

const MAX_ITEMS = 60
const SCAN_MAX_DIRS = 800
const SCAN_MAX_DEPTH = 4
const EMIT_DEBOUNCE_MS = 250

interface Watched {
  cwd: string
  watcher: FSWatcher | null
  /** abs path -> item */
  items: Map<string, AssetItem>
  timer: ReturnType<typeof setTimeout> | null
  disposed: boolean
}

export class AssetWatchers {
  private readonly byId = new Map<string, Watched>()

  constructor(private readonly onChange: (id: string, assets: AssetItem[]) => void) {}

  /** Reconcile watchers with the current roster (call on every roster event). */
  sync(roster: SessionInfo[]): void {
    const wanted = new Map(roster.map((s) => [s.id, s.cwd]))
    for (const id of [...this.byId.keys()]) {
      if (!wanted.has(id)) this.remove(id)
    }
    for (const [id, cwd] of wanted) {
      if (!this.byId.has(id)) this.add(id, cwd)
    }
  }

  /** Newest-first asset list for a session. */
  list(id: string): AssetItem[] {
    const w = this.byId.get(id)
    if (!w) return []
    return [...w.items.values()].sort((a, b) => b.mtime - a.mtime)
  }

  /** Is this absolute path a currently-known asset? (crew-asset:// allowlist) */
  has(path: string): boolean {
    for (const w of this.byId.values()) {
      if (w.items.has(path)) return true
    }
    return false
  }

  /** The watched cwd for a session (for resolving relative path tokens). */
  cwdOf(id: string): string | null {
    return this.byId.get(id)?.cwd ?? null
  }

  /**
   * Explicitly add one file (e.g. a path the agent printed and the user
   * clicked) to a session's asset list — even outside the scan depth or cwd.
   * Returns the item, or null if the file is missing or not previewable.
   */
  async pin(id: string, absPath: string): Promise<AssetItem | null> {
    const w = this.byId.get(id)
    if (!w || !assetKind(absPath)) return null
    try {
      const st = await stat(absPath)
      if (!st.isFile()) return null
      let rel = relative(w.cwd, absPath).split(sep).join('/')
      if (rel.startsWith('..')) rel = absPath // outside cwd: display absolute
      this.upsert(w, absPath, rel, st.size, st.mtimeMs)
      this.scheduleEmit(id, w)
      return w.items.get(absPath) ?? null
    } catch {
      return null
    }
  }

  disposeAll(): void {
    for (const id of [...this.byId.keys()]) this.remove(id)
  }

  private add(id: string, cwd: string): void {
    const w: Watched = { cwd, watcher: null, items: new Map(), timer: null, disposed: false }
    this.byId.set(id, w)

    try {
      w.watcher = watch(cwd, { recursive: true }, (_event, filename) => {
        if (!filename || w.disposed) return
        const rel = filename.toString()
        if (isIgnoredRelPath(rel) || !assetKind(rel)) return
        void this.refreshOne(id, w, rel)
      })
      w.watcher.on('error', () => {
        /* cwd deleted or unwatchable — keep whatever we scanned */
      })
    } catch {
      /* cwd missing; panel just stays empty */
    }

    void this.scan(id, w)
  }

  private remove(id: string): void {
    const w = this.byId.get(id)
    if (!w) return
    w.disposed = true
    if (w.timer) clearTimeout(w.timer)
    try {
      w.watcher?.close()
    } catch {
      /* already closed */
    }
    this.byId.delete(id)
  }

  /** Stat one changed file and upsert/remove it, then emit (debounced). */
  private async refreshOne(id: string, w: Watched, rel: string): Promise<void> {
    const abs = join(w.cwd, rel)
    try {
      const st = await stat(abs)
      if (!st.isFile()) return
      this.upsert(w, abs, rel, st.size, st.mtimeMs)
    } catch {
      if (!w.items.delete(abs)) return
    }
    this.scheduleEmit(id, w)
  }

  /** Bounded BFS over cwd for existing assets (newest MAX_ITEMS win). */
  private async scan(id: string, w: Watched): Promise<void> {
    const queue: Array<{ dir: string; rel: string; depth: number }> = [
      { dir: w.cwd, rel: '', depth: 0 }
    ]
    let dirs = 0
    while (queue.length > 0 && dirs < SCAN_MAX_DIRS) {
      const { dir, rel, depth } = queue.shift()!
      if (w.disposed) return
      dirs++
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (depth < SCAN_MAX_DEPTH && !isIgnoredDir(e.name)) {
            queue.push({ dir: join(dir, e.name), rel: rel ? rel + '/' + e.name : e.name, depth: depth + 1 })
          }
        } else if (e.isFile() && !e.name.startsWith('.') && assetKind(e.name)) {
          const abs = join(dir, e.name)
          try {
            const st = await stat(abs)
            this.upsert(w, abs, rel ? rel + '/' + e.name : e.name, st.size, st.mtimeMs)
          } catch {
            /* raced a delete */
          }
        }
      }
    }
    if (!w.disposed && w.items.size > 0) this.scheduleEmit(id, w)
  }

  private upsert(w: Watched, abs: string, rel: string, size: number, mtime: number): void {
    const name = rel.slice(rel.lastIndexOf('/') + 1)
    const relDir = rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
    const kind = assetKind(name)
    if (!kind) return
    w.items.set(abs, {
      path: abs,
      name,
      relDir,
      ext: name.slice(name.lastIndexOf('.') + 1).toLowerCase(),
      kind,
      size,
      mtime
    })
    // Cap memory: drop the oldest beyond MAX_ITEMS.
    if (w.items.size > MAX_ITEMS) {
      const sorted = [...w.items.values()].sort((a, b) => b.mtime - a.mtime)
      for (const item of sorted.slice(MAX_ITEMS)) w.items.delete(item.path)
    }
  }

  private scheduleEmit(id: string, w: Watched): void {
    if (w.timer) return
    w.timer = setTimeout(() => {
      w.timer = null
      if (!w.disposed) this.onChange(id, this.list(id))
    }, EMIT_DEBOUNCE_MS)
  }
}
