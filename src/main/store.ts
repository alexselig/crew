// Minimal local JSON persistence. MVP deliberately avoids a native SQLite
// dependency (which would need per-Electron-ABI rebuilds); a small JSON file in
// the user-data dir is plenty for labels, character assignments and settings.
//
// Privacy: we persist ONLY labels, character map and settings — never terminal
// output, prompts, env values, or secrets (see SPEC §11).

import { readFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, basename } from 'node:path'
import type { Agent, CustomView, CustomViewItem, CustomViewMode, Settings, SessionSet } from '../shared/types'
import { workspaceNames, normalizeSetNames, nameToIdMap, createWorkspace, type Workspace } from '../shared/workspaces'
import { BUILTIN_AGENTS } from '../shared/agents'
import { atomicWriteFile } from './atomic-file'

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
  /** Conversation this session succeeded, when relaunched in 'brief' mode. Kept
   * so the original transcript is never orphaned by starting a fresh agent. */
  priorSessionId?: string
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
  contextMode: 'auto',
  budgetUsd: 0,
  inputTokenWarn: 100000,
  captureTranscripts: false,
  staleHideHours: 72,
  minimizedAsList: true,
  enhancedTerminal: false,
  showGithubButton: true,
  githubButtonOpensRepo: true
}

interface StoreData {
  characters: Record<string, CharacterAssignment>
  settings: Settings
  recentDirs: string[]
  sessions: PersistedSession[]
  sets: SessionSet[]
  workspaces: Workspace[]
  customViews: CustomView[]
  agents: Agent[]
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
  workspaces: [],
  customViews: [],
  agents: []
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
  },
  {
    // Move stores stuck on all-or-nothing 'brief' onto 'auto'. Brief was the
    // only escape from replaying a huge log, and it cost every *short* session
    // its real history too — a two-line conversation came back as a summary.
    // 'auto' keeps the transcript until it actually outgrows the context window,
    // which is what picking 'brief' was really asking for.
    id: '2026-08-context-mode-auto',
    apply: (d) => {
      if (d.settings.contextMode === 'brief') d.settings.contextMode = 'auto'
    }
  },
  {
    // Seed the built-in specialist agents once. Users can edit/delete them after.
    id: '2026-08-agents-seed',
    apply: (d) => {
      if ((d.agents?.length ?? 0) > 0) return
      d.agents = BUILTIN_AGENTS.map((a) => ({ ...a }))
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

/** Where dated snapshots live, relative to the store file's directory. */
const SNAPSHOT_DIR = 'backups'
/** How many dated snapshots to keep — roughly two weeks of history. */
const SNAPSHOT_KEEP = 14
const SNAPSHOT_PREFIX = 'crew-store-'

class InvalidStoreError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(err: unknown): boolean {
  return isRecord(err) && err.code === 'ENOENT'
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString)
const CUSTOM_VIEW_MODES: readonly CustomViewMode[] = ['curated-only', 'ranked-plus-all']

type CustomViewInput = Pick<CustomView, 'name' | 'mode' | 'items'>

function isCustomViewMode(value: unknown): value is CustomViewMode {
  return isString(value) && CUSTOM_VIEW_MODES.includes(value as CustomViewMode)
}

function validateCustomViewItems(items: unknown): CustomViewItem[] {
  if (!Array.isArray(items)) throw new Error('custom view items must be an array')
  const seen = new Set<string>()
  const normalized: CustomViewItem[] = []
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) throw new Error(`custom view items[${index}] must be an object`)
    if (!isString(item.sessionId) || item.sessionId.trim().length === 0) {
      throw new Error(`custom view items[${index}] sessionId must be a non-empty string`)
    }
    if (!isString(item.labelSnapshot)) {
      throw new Error(`custom view items[${index}] labelSnapshot must be a string`)
    }
    const sessionId = item.sessionId.trim()
    if (seen.has(sessionId)) continue
    seen.add(sessionId)
    normalized.push({
      sessionId,
      labelSnapshot: item.labelSnapshot
    })
  }
  return normalized
}

function normalizeCustomViewInput(
  input: CustomViewInput,
  existing: readonly CustomView[],
  currentId?: string
): CustomViewInput {
  if (!isString(input.name)) throw new Error('custom view name must be a string')
  const name = input.name.trim()
  if (name.length === 0) throw new Error('custom view name is required')
  if (!isCustomViewMode(input.mode)) throw new Error(`invalid custom view mode: ${String(input.mode)}`)
  const nameKey = name.toLocaleLowerCase()
  if (existing.some((view) => view.id !== currentId && view.name.trim().toLocaleLowerCase() === nameKey)) {
    throw new Error(`custom view "${name}" already exists`)
  }
  return {
    name,
    mode: input.mode,
    items: validateCustomViewItems(input.items)
  }
}

function isCustomViewItem(value: unknown): value is CustomViewItem {
  return isRecord(value) &&
    isString(value.sessionId) &&
    value.sessionId.trim().length > 0 &&
    isString(value.labelSnapshot)
}

function isCustomView(value: unknown): value is CustomView {
  return isRecord(value) &&
    isString(value.id) &&
    value.id.trim().length > 0 &&
    isString(value.name) &&
    value.name.trim().length > 0 &&
    isCustomViewMode(value.mode) &&
    Array.isArray(value.items) &&
    value.items.every(isCustomViewItem) &&
    isNumber(value.createdAt) &&
    isNumber(value.updatedAt) &&
    new Set(value.items.map((item) => item.sessionId.trim())).size === value.items.length
}

function hasUniqueCustomViewNames(views: readonly CustomView[]): boolean {
  const names = new Set<string>()
  for (const view of views) {
    const key = view.name.trim().toLocaleLowerCase()
    if (names.has(key)) return false
    names.add(key)
  }
  return true
}

function hasUniqueCustomViewIds(views: readonly CustomView[]): boolean {
  const ids = new Set<string>()
  for (const view of views) {
    if (ids.has(view.id)) return false
    ids.add(view.id)
  }
  return true
}

function optionalFields(record: Record<string, unknown>, keys: string[], valid: (value: unknown) => boolean): boolean {
  return keys.every((key) => record[key] === undefined || valid(record[key]))
}

function validSession(value: unknown, savedSet = false): boolean {
  return isRecord(value) &&
    ['command', 'cwd', 'label', ...(savedSet ? [] : ['id', 'characterId'])].every((key) => isString(value[key])) &&
    (value.presetId === null || isString(value.presetId)) && isStrings(value.args) &&
    optionalFields(value, ['id', 'characterId', 'color', 'tag', 'description', 'agentSessionId', 'priorSessionId'], isString) &&
    optionalFields(value, ['sets', 'workspaceIds'], isStrings) &&
    optionalFields(value, ['createdAt', 'lastPromptAt'], isNumber)
}

/** Validate before migrations, including stores where all migrations ran already.
 * Missing legacy fields still default as before; present malformed fields do not. */
function validateStore(raw: unknown): asserts raw is Partial<StoreData> {
  if (!isRecord(raw)) throw new InvalidStoreError('store must be an object')
  const arrays: Record<string, (value: unknown) => boolean> = {
    recentDirs: isString,
    migrations: isString,
    sessions: (value) => validSession(value),
    sets: (value) => isRecord(value) && isString(value.name) &&
      Array.isArray(value.sessions) && value.sessions.every((s) => validSession(s, true)),
    workspaces: (value) => isRecord(value) && isString(value.id) && isString(value.name) &&
      isNumber(value.order) && isNumber(value.createdAt) && optionalFields(value, ['description'], isString),
    customViews: (value) => isCustomView(value),
    agents: (value) => isRecord(value) &&
      ['id', 'name', 'icon', 'base', 'persona'].every((key) => isString(value[key])) &&
      (value.contextMode === 'cwd' || value.contextMode === 'cwd+transcript') &&
      typeof value.writes === 'boolean' && isNumber(value.order) &&
      optionalFields(value, ['color'], isString) && optionalFields(value, ['builtin'], (v) => typeof v === 'boolean')
  }
  for (const [key, valid] of Object.entries(arrays)) {
    const value = raw[key]
    if (value !== undefined && (!Array.isArray(value) || !value.every(valid))) {
      throw new InvalidStoreError(`invalid store ${key}`)
    }
  }
  if (raw.characters !== undefined && (!isRecord(raw.characters) ||
    !Object.values(raw.characters).every((v) => isRecord(v) && isString(v.characterId) && isString(v.lastLabel)))) {
    throw new InvalidStoreError('invalid store characters')
  }
  if (raw.settings !== undefined) {
    if (!isRecord(raw.settings)) throw new InvalidStoreError('invalid store settings')
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      const value = raw.settings[key]
      if (value !== undefined && (typeof value !== typeof fallback || (typeof value === 'number' && !isNumber(value)))) {
        throw new InvalidStoreError(`invalid store settings.${key}`)
      }
    }
  }
  const bounds = raw.windowBounds
  if (bounds !== undefined && (!isRecord(bounds) ||
    !['x', 'y', 'width', 'height'].every((key) => isNumber(bounds[key])))) {
    throw new InvalidStoreError('invalid store windowBounds')
  }
  if (raw.customViews !== undefined && Array.isArray(raw.customViews)) {
    if (!hasUniqueCustomViewNames(raw.customViews)) {
      throw new InvalidStoreError('invalid store customViews: duplicate names')
    }
    if (!hasUniqueCustomViewIds(raw.customViews)) {
      throw new InvalidStoreError('invalid store customViews: duplicate ids')
    }
  }
}

function parseStore(contents: string): Partial<StoreData> {
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch (err) {
    throw new InvalidStoreError(`invalid store JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  validateStore(raw)
  return raw
}

export class Store {
  private data: StoreData
  private saveBlocked: string | undefined
  private dirty = false
  private batch: { failure?: { error: unknown } } | undefined

  /** onError may run during construction; saves retain unsaved memory on failure. */
  constructor(private readonly path: string, private readonly onError?: (message: string) => void) {
    const { data, migrated } = this.load()
    this.data = data
    // Snapshot what we just loaded, before anything can overwrite it. The .bak
    // rotation only survives two saves, and the store is rewritten on nearly
    // every event — so a bug that prunes the roster destroys all three copies
    // within seconds. A dated snapshot is the only thing that survives that.
    if (!this.saveBlocked) this.snapshot()
    // A migration that changed persisted data must be written back immediately,
    // so it records as applied and never re-runs on the next launch.
    if (migrated) this.persist()
  }

  /** Synchronous only. Nested batches share one snapshot and one publication.
   * Any callback throw aborts the outer batch, even if an inner throw is caught.
   * A returned value signals callback completion, not durability: save failures
   * still report through onError and remain dirty for the next save/batch. */
  batchUpdates<T>(fn: () => T): T {
    if (this.batch) {
      try {
        return fn()
      } catch (error) {
        this.batch.failure ??= { error }
        throw error
      }
    }
    const snapshot = structuredClone(this.data)
    const wasDirty = this.dirty
    const batch: { failure?: { error: unknown } } = {}
    this.batch = batch
    let result: T
    try {
      result = fn()
      if (batch.failure) throw batch.failure.error
    } catch (error) {
      this.data = snapshot
      this.dirty = wasDirty
      throw error
    } finally {
      this.batch = undefined
    }
    if (this.dirty) this.persist()
    return result
  }

  private load(): { data: StoreData; migrated: boolean } {
    let corruptPrimary = false
    let failed = false
    try {
      return this.readFrom(this.path)
    } catch (err) {
      if (!isMissing(err)) {
        failed = true
        corruptPrimary = err instanceof InvalidStoreError
        if (!corruptPrimary) this.saveBlocked = 'live store is inaccessible; restart after restoring access'
        this.report(`could not read store ${this.path}`, err)
      }
    }
    const recover = (candidate: string): { data: StoreData; migrated: boolean } | undefined => {
      let recovered: { data: StoreData; migrated: boolean }
      try {
        recovered = this.readFrom(candidate)
      } catch (err) {
        if (!isMissing(err)) {
          failed = true
          this.report(`could not recover store from ${candidate}`, err)
        }
        return undefined
      }
      if (corruptPrimary) {
        const quarantine = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`
        try {
          renameSync(this.path, quarantine)
          console.warn(`[crew] preserved corrupt store at ${quarantine}`)
        } catch (err) {
          this.saveBlocked = 'corrupt live store could not be preserved; restart after repairing storage'
          this.report(this.saveBlocked, err)
        }
      }
      this.report(`recovered store from ${candidate}${this.saveBlocked ? '; saving is disabled' : ''}`)
      return { ...recovered, migrated: true }
    }
    for (const candidate of [`${this.path}.bak`, `${this.path}.bak2`]) {
      const recovered = recover(candidate)
      if (recovered) return recovered
    }
    try {
      for (const name of this.snapshots().reverse()) {
        const recovered = recover(join(this.snapshotDir, name))
        if (recovered) return recovered
      }
    } catch (err) {
      failed = true
      this.report('could not inspect store snapshots', err)
    }
    if (failed) {
      this.saveBlocked ??= 'no readable store or backup; saving is disabled until storage is repaired and Crew restarted'
      this.report(this.saveBlocked)
    }
    // An irrecoverable store only gets a reported, read-only in-memory baseline.
    // Leave the original files untouched for manual recovery.
    return {
      data: {
        ...EMPTY,
        settings: { ...DEFAULT_SETTINGS },
        characters: {},
        recentDirs: [],
        sessions: [],
        sets: [],
        workspaces: [],
        customViews: [],
        agents: BUILTIN_AGENTS.map((a) => ({ ...a })),
        migrations: MIGRATIONS.map((m) => m.id)
      },
      migrated: false
    }
  }

  /** Parse a store file into a fully-defaulted StoreData. Throws when the file
   * is missing or unparseable, so callers can fall through to a backup. */
  private readFrom(path: string): { data: StoreData; migrated: boolean } {
    const raw = parseStore(readFileSync(path, 'utf8'))
    const data: StoreData = {
      characters: raw.characters ?? {},
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      recentDirs: raw.recentDirs ?? [],
      sessions: raw.sessions ?? [],
      sets: raw.sets ?? [],
      workspaces: raw.workspaces ?? [],
      customViews: raw.customViews ?? [],
      agents: raw.agents ?? [],
      windowBounds: raw.windowBounds,
      migrations: [...(raw.migrations ?? [])]
    }
    const migrated = runMigrations(data)
    return { data, migrated }
  }

  private persist(throwOnFailure = false): void {
    this.dirty = true
    if (this.batch) return
    if (this.saveBlocked) {
      const error = new Error(`failed to persist store: ${this.saveBlocked}`)
      this.report(error.message)
      if (throwOnFailure) throw error
      return
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Keep the previous good copy before overwriting. The roster is the only
      // record of which conversation each session maps to, and it is rewritten
      // on nearly every event — so a single bad write (or a bug that prunes the
      // list) would otherwise be unrecoverable. Cheap insurance: one .bak, one
      // .bak2, rotated on each save.
      this.rotateBackups()
      atomicWriteFile(this.path, JSON.stringify(this.data, null, 2))
      this.dirty = false
    } catch (err) {
      // Non-fatal: persistence is best-effort. Losing labels between runs is
      // preferable to crashing the app on a read-only disk — but surface it.
      this.report('failed to persist store; changes remain in memory', err)
      if (throwOnFailure) throw err
    }
  }

  private mutateCustomViewsDurably<T>(mutate: () => T): T {
    const previous = structuredClone(this.data.customViews)
    const wasDirty = this.dirty
    try {
      const result = mutate()
      this.persist(true)
      return result
    } catch (error) {
      this.data.customViews = previous
      this.dirty = wasDirty
      throw error
    }
  }

  private report(message: string, err?: unknown): void {
    const detail = err === undefined ? message : `${message}: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[crew] ${detail}`)
    try {
      this.onError?.(detail)
    } catch (callbackError) {
      console.warn('[crew] store error callback failed:', callbackError)
    }
  }

  /** Fail the save if its safety copy cannot be published. Never truncate a
   * rotation in place or rotate an externally corrupted primary over good data. */
  private rotateBackups(): void {
    let primary: Buffer
    try {
      primary = readFileSync(this.path)
      parseStore(primary.toString('utf8'))
    } catch (err) {
      if (isMissing(err)) return
      throw err
    }
    let previous: Buffer | undefined
    try {
      const contents = readFileSync(`${this.path}.bak`)
      parseStore(contents.toString('utf8'))
      previous = contents
    } catch (err) {
      if (err instanceof InvalidStoreError) this.report('skipping corrupt store rotation', err)
      else if (!isMissing(err)) throw err
    }
    if (previous) atomicWriteFile(`${this.path}.bak2`, previous)
    atomicWriteFile(`${this.path}.bak`, primary)
  }

  /** The directory holding dated snapshots. */
  get snapshotDir(): string {
    return join(dirname(this.path), SNAPSHOT_DIR)
  }

  /** Existing snapshots, oldest first. The filename carries the date, so a
   * plain lexical sort is chronological. */
  private snapshots(): string[] {
    try {
      return readdirSync(this.snapshotDir)
        .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json'))
        .sort()
    } catch (err) {
      if (isMissing(err)) return []
      throw err
    }
  }

  /**
   * Write at most one dated snapshot per day, keeping the last SNAPSHOT_KEEP.
   *
   * Deliberately refuses to snapshot an empty roster: the failure this exists to
   * catch is the roster being silently pruned, and snapshotting that state would
   * spend a retention slot recording the damage instead of the last good copy.
   *
   * Best-effort — a failed snapshot must never stop the app from starting.
   */
  private snapshot(): void {
    if (this.data.sessions.length === 0) return
    try {
      const day = new Date().toISOString().slice(0, 10)
      const file = join(this.snapshotDir, `${SNAPSHOT_PREFIX}${day}.json`)
      if (existsSync(file)) return
      mkdirSync(this.snapshotDir, { recursive: true })
      atomicWriteFile(file, JSON.stringify(this.data, null, 2))
      for (const stale of this.snapshots().slice(0, -SNAPSHOT_KEEP)) {
        try {
          unlinkSync(join(this.snapshotDir, stale))
        } catch (err) {
          this.report(`failed to prune store snapshot ${stale}`, err)
        }
      }
    } catch (err) {
      this.report('failed to snapshot store', err)
    }
  }

  /** Dated snapshots available to restore from, newest first, with the session
   * count each one holds so a caller can tell a healthy roster from a pruned one. */
  listSnapshots(): { file: string; day: string; sessions: number }[] {
    const out: { file: string; day: string; sessions: number }[] = []
    let names: string[]
    try {
      names = this.snapshots().reverse()
    } catch (err) {
      this.report('failed to list store snapshots', err)
      return out
    }
    for (const name of names) {
      const file = join(this.snapshotDir, name)
      try {
        const data = parseStore(readFileSync(file, 'utf8'))
        out.push({
          file,
          day: basename(name, '.json').slice(SNAPSHOT_PREFIX.length),
          sessions: data.sessions?.length ?? 0
        })
      } catch (err) {
        this.report(`failed to read store snapshot ${file}`, err)
      }
    }
    return out
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

  getCustomViews(): CustomView[] {
    return structuredClone(this.data.customViews)
  }

  createCustomView(input: CustomViewInput): CustomView {
    const normalized = normalizeCustomViewInput(input, this.data.customViews)
    const now = Date.now()
    const view: CustomView = {
      id: randomUUID(),
      name: normalized.name,
      mode: normalized.mode,
      items: normalized.items,
      createdAt: now,
      updatedAt: now
    }
    this.mutateCustomViewsDurably(() => {
      this.data.customViews = [...this.data.customViews, view]
    })
    return structuredClone(view)
  }

  updateCustomView(id: string, input: CustomViewInput): CustomView {
    const current = this.data.customViews.find((view) => view.id === id)
    if (!current) throw new Error(`custom view not found: ${id}`)
    const normalized = normalizeCustomViewInput(input, this.data.customViews, id)
    const updated: CustomView = {
      ...current,
      name: normalized.name,
      mode: normalized.mode,
      items: normalized.items,
      updatedAt: Date.now()
    }
    this.mutateCustomViewsDurably(() => {
      this.data.customViews = this.data.customViews.map((view) => view.id === id ? updated : view)
    })
    return structuredClone(updated)
  }

  deleteCustomView(id: string): CustomView[] {
    if (!this.data.customViews.some((view) => view.id === id)) {
      throw new Error(`custom view not found: ${id}`)
    }
    this.mutateCustomViewsDurably(() => {
      this.data.customViews = this.data.customViews.filter((view) => view.id !== id)
    })
    return structuredClone(this.data.customViews)
  }

  /** Specialist agent definitions (Agents shelf). */
  getAgents(): Agent[] {
    return this.data.agents
  }

  saveAgents(list: Agent[]): Agent[] {
    this.data.agents = list
    this.persist()
    return this.data.agents
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
