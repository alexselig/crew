// Minimal local JSON persistence. MVP deliberately avoids a native SQLite
// dependency (which would need per-Electron-ABI rebuilds); a small JSON file in
// the user-data dir is plenty for labels, character assignments and settings.
//
// Privacy: we persist ONLY labels, character map and settings — never terminal
// output, prompts, env values, or secrets (see SPEC §11).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings, SessionSet } from '../shared/types'
import { workspaceNames, normalizeSetNames } from '../shared/workspaces'

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
  sets: []
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
        windowBounds: raw.windowBounds,
        migrations: [...(raw.migrations ?? [])]
      }
      const migrated = runMigrations(data)
      return { data, migrated }
    } catch {
      // Fresh (or unreadable) store: start at the latest schema and mark every
      // migration as already applied — there's nothing to upgrade on a clean
      // slate, and this avoids nudging a value the user later sets themselves.
      // Not persisted here, staying non-destructive if the file was merely
      // unreadable; the baseline is written on the first real save.
      return {
        data: {
          ...EMPTY,
          characters: {},
          recentDirs: [],
          sessions: [],
          sets: [],
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
