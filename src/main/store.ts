// Minimal local JSON persistence. MVP deliberately avoids a native SQLite
// dependency (which would need per-Electron-ABI rebuilds); a small JSON file in
// the user-data dir is plenty for labels, character assignments and settings.
//
// Privacy: we persist ONLY labels, character map and settings — never terminal
// output, prompts, env values, or secrets (see SPEC §11).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CharacterAssignment {
  characterId: string
  lastLabel: string
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
}

export interface Settings {
  notifications: boolean
  sound: boolean
  notifyOnlyWhenUnfocused: boolean
  sortNeedsYouFirst: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  sound: false,
  notifyOnlyWhenUnfocused: false,
  sortNeedsYouFirst: true
}

interface StoreData {
  characters: Record<string, CharacterAssignment>
  settings: Settings
  recentDirs: string[]
  sessions: PersistedSession[]
}

const EMPTY: StoreData = {
  characters: {},
  settings: { ...DEFAULT_SETTINGS },
  recentDirs: [],
  sessions: []
}

/** Build the stable identity key used to re-assign a character/label to the
 * same "job" (preset + working dir) across relaunches. */
export function identityKey(presetId: string | null, cwd: string): string {
  return `${presetId ?? 'custom'}::${cwd}`
}

export class Store {
  private data: StoreData

  constructor(private readonly path: string) {
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreData>
      return {
        characters: raw.characters ?? {},
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recentDirs: raw.recentDirs ?? [],
        sessions: raw.sessions ?? []
      }
    } catch {
      return { ...EMPTY, characters: {}, recentDirs: [], sessions: [] }
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
}
