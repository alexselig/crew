// Minimal local JSON persistence. MVP deliberately avoids a native SQLite
// dependency (which would need per-Electron-ABI rebuilds); a small JSON file in
// the user-data dir is plenty for labels, character assignments and settings.
//
// Privacy: we persist ONLY labels, character map and settings — never terminal
// output, prompts, env values, or secrets (see SPEC §11).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings, SessionSet } from '../shared/types'
import { workspaceNames, normalizeSetNames, nameToIdMap, createWorkspace, type Workspace } from '../shared/workspaces'

export interface CharacterAssignment {
  characterId: string
  lastLabel: string
}

/** Last known main-window frame, so Crew reopens where you left it (e.g. on a
 * second monitor). Restored only if it still lands on a connected display. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A session descriptor persisted so it can be re-launched on next startup. */
export interface PersistedSession {
  id: string
  presetId: string | null
  command: string
  args: string[]
  cwd: string
  label: string
  characterId: string
  color?: string
  tag?: string
  /** Workspaces (named sets) this session belongs to. */
  sets?: string[]
  /** Workspace ids this session belongs to (first-class membership). */
  workspaceIds?: string[]
  /** Freeform user note shown in the Workspace Manager. */
  description?: string
  /** The agent's session UUID, so restore reattaches the same conversation. */
  agentSessionId?: string
  /** Epoch ms the session was first created, preserved across restart. */
  createdAt?: number
  /** Epoch ms of the user's last prompt, so 'recent' grouping survives restart. */
  lastPromptAt?: number
}

export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  sound: false,
  notifyOnlyWhenUnfocused: false,
  sortNeedsYouFirst: true,
  launchAtLogin: false,
  showSpend: true,
  showCredits: false,
  costMode: 'auto',
  aicPerUsd: 100,
  resumeConversations: true,
  budgetUsd: 0,
  inputTokenWarn: 100000,
  captureTranscripts: false,
  staleHideHours: 72,
  minimizedAsList: true,
  enhancedTerminal: false
}

interface StoreData {
  characters: Record<string, CharacterAssignment>
  settings: Settings
  recentDirs: string[]
  sessions: PersistedSession[]
  sets: SessionSet[]
  workspaces: Workspace[]
  windowBounds?: WindowBounds
  /** Ids of the one-time data migrations already applied to this store (see
   * MIGRATIONS), so each runs at most once. */
  migrations?: string[]
}

const EMPTY: StoreData = {
  characters: {},
  settings: { ...DEFAULT_SETTINGS },
  recentDirs: [],
  sessions: [],
  sets: [],
  workspaces: []
}

/** One-time, ordered data migrations. Each is recorded by id in
 * `data.migrations` after it runs, so it applies at most once per store and
 * never re-fires against a value the user has since chosen. */
const MIGRATIONS: Array<{ id: string; apply: (d: StoreData) => void }> = [
  {
    // Bump the previous 12h stale-hide default to 72h so a session last prompted
    // on Friday still shows on Monday. Only nudges stores still sitting on the
    // old default; any other value the user picked is left untouched.
    id: '2026-07-stale-hide-72h',
    apply: (d) => {
      if (d.settings.staleHideHours === 12) d.settings.staleHideHours = 72
    }
  },
  {
    // Promote name-based workspaces (session.sets + empty SessionSets) to
    // first-class Workspace entities with stable ids, and rewrite each session's
    // membership to workspaceIds. Non-empty resume bundles in `sets` are left
    // untouched (they power Save & Park).
    id: '2026-08-workspaces-firstclass',
    apply: (d) => {
      if ((d.workspaces?.length ?? 0) > 0) return
      const names: string[] = []
      for (const s of d.sessions) if (s.sets) names.push(...s.sets)
      for (const set of d.sets) if (set.sessions.length === 0) names.push(set.name)
      let list: Workspace[] = []
      let now = Date.now()
      for (const name of normalizeSetNames(names)) {
        list = createWorkspace(list, name, now++).list
      }
      d.workspaces = list
      const byName = nameToIdMap(list)
      for (const s of d.sessions) {
        if (s.workspaceIds) continue
        s.workspaceIds = (s.sets ?? [])
          .map((n) => byName.get(n.trim().toLowerCase()))
          .filter((x): x is string => !!x)
      }
    }
  }
]

/** Apply any not-yet-recorded MIGRATIONS to `data` in place, recording each by
 * id. Returns true when at least one migration ran, so the caller re-persists. */
function runMigrations(data: StoreData): boolean {
  const applied = new Set(data.migrations ?? [])
  let changed = false
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    m.apply(data)
    applied.add(m.id)
    changed = true
  }
  data.migrations = [...applied]
  return changed
}

/** Build the stable identity key used to re-assign a character/label to the
 * same "job" (preset + working dir) across relaunches. */
export function identityKey(presetId: string | null, cwd: string): string {
  return `${presetId ?? 'custom'}::${cwd}`
}

export class Store {
  private data: StoreData

  constructor(private readonly path: string) {
    const { data, migrated } = this.load()
    this.data = data
    // A migration that changed persisted data must be written back immediately,
    // so it records as applied and never re-runs on the next launch.
    if (migrated) this.persist()
  }

  private load(): { data: StoreData; migrated: boolean } {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreData>
      const data: StoreData = {
        characters: raw.characters ?? {},
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recentDirs: raw.recentDirs ?? [],
        sessions: raw.sessions ?? [],
        sets: raw.sets ?? [],
        workspaces: raw.workspaces ?? [],
        windowBounds: raw.windowBounds,
        migrations: [...(raw.migrations ?? [])]
      }
      const migrated = runMigrations(data)
      return { data, migrated }
    } catch {
      // Distinguish a fresh start (no file) from a CORRUPT existing file. For a
      // clean slate there's nothing to preserve. But if the file exists and
      // merely failed to parse (e.g. a truncated write after a crash), move it
      // aside to a timestamped backup BEFORE we continue on an empty baseline —
      // otherwise the first save would overwrite it and lose recoverable data.
      if (existsSync(this.path)) {
        const backup = `${this.path}.corrupt-${Date.now()}`
        try {
          renameSync(this.path, backup)
          console.warn(`[crew] store unreadable; preserved corrupt file at ${backup}`)
        } catch (err) {
          console.warn('[crew] store unreadable and could not be backed up:', err instanceof Error ? err.message : err)
        }
      }
      // Start at the latest schema and mark every migration as already applied —
      // there's nothing to upgrade on a clean slate, and this avoids nudging a
      // value the user later sets themselves. The baseline is written on the
      // first real save.
      return {
        data: {
          ...EMPTY,
          characters: {},
          recentDirs: [],
          sessions: [],
          sets: [],
          workspaces: [],
          migrations: MIGRATIONS.map((m) => m.id)
        },
        migrated: false
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(this.data, null, 2))
    } catch (err) {
      // Non-fatal: persistence is best-effort. Losing labels between runs is
      // preferable to crashing the app on a read-only disk — but surface it.
      console.warn('[crew] failed to persist store:', err instanceof Error ? err.message : err)
    }
  }

  getAssignment(key: string): CharacterAssignment | undefined {
    return this.data.characters[key]
  }

  setAssignment(key: string, assignment: CharacterAssignment): void {
    this.data.characters[key] = assignment
    this.persist()
  }

  get settings(): Settings {
    return this.data.settings
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch }
    this.persist()
    return this.data.settings
  }

  get recentDirs(): string[] {
    return this.data.recentDirs
  }

  addRecentDir(dir: string): void {
    const next = [dir, ...this.data.recentDirs.filter((d) => d !== dir)].slice(0, 10)
    this.data.recentDirs = next
    this.persist()
  }

  /** The set of sessions to re-launch on next startup. */
  getSessions(): PersistedSession[] {
    return this.data.sessions
  }

  saveSessions(list: PersistedSession[]): void {
    this.data.sessions = list
    this.persist()
  }

  get sets(): SessionSet[] {
    return this.data.sets
  }

  upsertSet(set: SessionSet): SessionSet[] {
    this.data.sets = [...this.data.sets.filter((s) => s.name !== set.name), set]
    this.persist()
    return this.data.sets
  }

  deleteSet(name: string): SessionSet[] {
    this.data.sets = this.data.sets.filter((s) => s.name !== name)
    this.persist()
    return this.data.sets
  }

  /** First-class workspaces (id-based). */
  getWorkspaces(): Workspace[] {
    return this.data.workspaces
  }

  saveWorkspaces(list: Workspace[]): Workspace[] {
    this.data.workspaces = list
    this.persist()
    return this.data.workspaces
  }

  /** Register workspace names as (possibly empty) sets so they persist and show
   *  up in menus/pickers even before a snapshot of open sessions is saved. */
  ensureSets(names: readonly string[]): void {
    let changed = false
    const existing = new Set(this.data.sets.map((s) => s.name.toLowerCase()))
    for (const name of normalizeSetNames(names)) {
      if (existing.has(name.toLowerCase())) continue
      this.data.sets.push({ name, sessions: [] })
      existing.add(name.toLowerCase())
      changed = true
    }
    if (changed) this.persist()
  }

  /** Union of all known workspace names: explicit sets + every session's membership. */
  workspaceNames(): string[] {
    return workspaceNames(
      this.data.sets.map((s) => s.name),
      this.data.sessions.map((s) => s.sets)
    )
  }

  get windowBounds(): WindowBounds | undefined {
    return this.data.windowBounds
  }

  setWindowBounds(bounds: WindowBounds): void {
    this.data.windowBounds = bounds
    this.persist()
  }
}
