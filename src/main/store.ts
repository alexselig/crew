// Minimal local JSON persistence. MVP deliberately avoids a native SQLite
// dependency (which would need per-Electron-ABI rebuilds); a small JSON file in
// the user-data dir is plenty for labels, character assignments and settings.
//
// Privacy: we persist ONLY labels, character map and settings — never terminal
// output, prompts, env values, or secrets (see SPEC §11).

import { readFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, basename } from 'node:path'
import type { Agent, CustomView, CustomViewGroupBy, CustomViewItem, CustomViewMode, Settings, SessionSet } from '../shared/types'
import {
  workspaceNames,
  normalizeSetNames,
  nameToIdMap,
  createWorkspace,
  markConductedWorkspaces,
  type Workspace
} from '../shared/workspaces'
import { BUILTIN_AGENTS } from '../shared/agents'
import type { ConductorConfig, ConductorLane, LaneAgent, TestRecipe } from '../shared/conductor'
import {
  validateMembershipChange,
  type MembershipSession,
  type MembershipWorkspace
} from '../shared/conductor-membership'
import { AtomicWriteError, atomicWriteFile, syncParentDirectory } from './atomic-file'

interface PersistInternalOptions {
  throwOnFailure?: boolean
}

interface FileFingerprint {
  size: number
  mtimeMs: number
}

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
  /**
   * The last size the pane reported, so a restored session's agent spawns at
   * the width it will actually be drawn into. Without this every relaunch
   * resets every session to the built-in default and the agent's first layout
   * is drawn for the wrong terminal.
   */
  cols?: number
  rows?: number
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
  githubButtonOpensRepo: true,
  calmMotion: true
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
  /** Per-workspace Conductor settings, one record per workspaceId. Validated
   * per-record on load: a malformed record is dropped, never coerced (see
   * isValidConductorConfig). */
  conductorConfigs: ConductorConfig[]
  /** The lane roster. Persisted so an app restart never orphans a lane's
   * worktree or its running session (see isValidConductorLane). */
  conductorLanes: ConductorLane[]
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
  agents: [],
  conductorConfigs: [],
  conductorLanes: []
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
    // Workspaces conducted before a workspace could be CREATED conducted. The
    // entry point that made them shipped in 0.7.5, and it set no flag on the
    // workspace — so after the flag became the only thing that shows conductor
    // UI, those workspaces would render no panel, no plan loader and no
    // Compose, while their lanes and worktrees stayed on disk and were rebuilt
    // on every launch. A persisted ConductorConfig is the definition of a
    // conducted workspace, so it is what the flag is restored from. Run here,
    // at load, because the flag must be set before any window asks for the
    // workspace list.
    id: '2026-09-conducted-workspace-flag',
    apply: (d) => {
      const marked = markConductedWorkspaces(
        d.workspaces ?? [],
        (d.conductorConfigs ?? []).map((c) => c.workspaceId)
      )
      if (marked.changed) d.workspaces = marked.list
    }
  },
  {
    // Seed the built-in specialist agents once. Users can edit/delete them after.
    id: '2026-08-agents-seed',
    apply: (d) => {
      if ((d.agents?.length ?? 0) > 0) return
      d.agents = BUILTIN_AGENTS.map((a) => ({ ...a }))
    }
  },
  {
    // Calm motion shipped in 0.7.6 as an opt-in, which meant the people it was
    // written for never got it: the mascot bob (`char-work`, translateY +
    // scale, 1.5s) runs once per WORKING session, independently phased, and a
    // roster of a hundred sessions reads as the whole list jittering. The
    // steady opacity breathe keeps the "this session is working" signal and
    // drops the travel, so it is the better default at any roster size. This
    // flips stores still sitting on the old default exactly once — the
    // migration id is recorded, so anyone who later turns the bob back on
    // keeps it.
    id: '2026-10-calm-motion-default',
    apply: (d) => {
      if (d.settings.calmMotion === false) d.settings.calmMotion = true
    }
  }
]

/** Every migration id, in order. Exported so tests that need a fully-migrated
 * store can seed one without hard-coding a list that breaks each time a
 * migration is added. */
export const MIGRATION_IDS: readonly string[] = MIGRATIONS.map((m) => m.id)

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

type CustomViewInput = Pick<CustomView, 'name' | 'mode' | 'groupBy' | 'items'>

function isCustomViewMode(value: unknown): value is CustomViewMode {
  return isString(value) && CUSTOM_VIEW_MODES.includes(value as CustomViewMode)
}

const CUSTOM_VIEW_GROUP_BYS: readonly CustomViewGroupBy[] = ['none', 'recent']

/** `undefined` is valid and means 'none' — views stored before groupBy existed
 * have no such field and must still load. */
function isCustomViewGroupBy(value: unknown): value is CustomViewGroupBy | undefined {
  return value === undefined || (isString(value) && CUSTOM_VIEW_GROUP_BYS.includes(value as CustomViewGroupBy))
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
  if (!isCustomViewGroupBy(input.groupBy)) {
    throw new Error(`invalid custom view groupBy: ${String(input.groupBy)}`)
  }
  const nameKey = name.toLocaleLowerCase()
  if (existing.some((view) => view.id !== currentId && view.name.trim().toLocaleLowerCase() === nameKey)) {
    throw new Error(`custom view "${name}" already exists`)
  }
  return {
    name,
    mode: input.mode,
    groupBy: input.groupBy ?? 'none',
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
    isCustomViewGroupBy(value.groupBy) &&
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

/** Keeps individual malformed entries out of a collection without failing the
 * whole store over them (unlike validateStore's whole-array validators). A
 * corrupt conductor record must not be able to take the session roster down
 * with it — see conductor-journal.ts's header comment for the same principle
 * applied to the journal. Collection-level corruption (present but not an
 * array) is caught earlier, in validateStore, and throws before this runs;
 * an absent key still defaults to [] here for back-compat. */
function filterValid<T>(value: unknown, valid: (v: unknown) => v is T): T[] {
  return Array.isArray(value) ? value.filter(valid) : []
}

function isValidTestRecipeStep(value: unknown): value is { command: string; args: string[]; timeoutMs: number } {
  return isRecord(value) && isString(value.command) && isStrings(value.args) && isNumber(value.timeoutMs)
}

function isValidTestRecipe(value: unknown): value is TestRecipe {
  return isRecord(value) &&
    isString(value.command) && isStrings(value.args) && isString(value.cwd) && isNumber(value.timeoutMs) &&
    (value.setup === undefined || isValidTestRecipeStep(value.setup))
}

/** A malformed record is dropped, never coerced: workspaceId, repo,
 * integrationBranch, integrationWorktree and lanesDir are the identity and
 * the filesystem paths this config points at, so an empty one is unusable,
 * not merely incomplete. */
function isValidConductorConfig(value: unknown): value is ConductorConfig {
  return isRecord(value) &&
    isString(value.workspaceId) && value.workspaceId.length > 0 &&
    isString(value.repo) && value.repo.length > 0 &&
    isString(value.integrationBranch) && value.integrationBranch.length > 0 &&
    isString(value.integrationWorktree) && value.integrationWorktree.length > 0 &&
    isString(value.lanesDir) && value.lanesDir.length > 0 &&
    isNumber(value.maxLanes) &&
    (value.test === null || isValidTestRecipe(value.test))
}

function isValidLaneAgent(value: unknown): value is LaneAgent {
  return isRecord(value) && isString(value.presetId) && (value.model === null || isString(value.model))
}

const LANE_STATUSES = ['working', 'publishing', 'blocked', 'done']

/** A lane whose id, worktree or branch is empty is malformed and dropped —
 * it points at a worktree that may not exist. branch is null for a reviewer
 * lane (detached, owns no branch): null is a valid state, only '' is not.
 * Task 5, finding 2 (fix round 1): workspaceId is optional on the
 * ConductorLane TYPE (an in-memory lane, fresh out of lanes.create(), has no
 * workspace concept of its own — see its doc comment in shared/conductor.ts)
 * but is required on a PERSISTED lane record: hydration
 * (createShippedConductorBackend) can only ever recover a lane for a
 * workspace whose id it can compare against, so a record with a missing,
 * non-string or empty workspaceId is not merely incomplete, it is
 * unreachable by every workspace forever — exactly the orphan-worktree
 * failure mode this whole subsystem exists to prevent. Dropped per-record,
 * like every other malformed field here: one bad lane must not quarantine
 * every workspace's roster. */
function isValidConductorLane(value: unknown): value is ConductorLane {
  return isRecord(value) &&
    isString(value.id) && value.id.length > 0 &&
    isString(value.roleId) &&
    (value.kind === 'author' || value.kind === 'reviewer') &&
    isValidLaneAgent(value.agent) &&
    isString(value.worktree) && value.worktree.length > 0 &&
    (value.branch === null || (isString(value.branch) && value.branch.length > 0)) &&
    (value.sessionId === null || isString(value.sessionId)) &&
    isString(value.status) && LANE_STATUSES.includes(value.status) &&
    optionalFields(value, ['blockedReason'], isString) &&
    isNumber(value.dispatches) &&
    isString(value.workspaceId) && value.workspaceId.length > 0
}

/**
 * The single enforcement point for src/shared/conductor-membership.ts's
 * exclusivity rule: no session may end up a member of more than one
 * conducted workspace. Every session-membership mutation in
 * session-manager.ts (setWorkspaceIds/addToWorkspace/removeFromWorkspace/
 * moveToWorkspace/archiveSession/…) bottoms out in Store.saveSessions with
 * the FULL proposed session list, so enforcing it exactly once here — rather
 * than at each of those call sites — is what makes it impossible to bypass.
 *
 * A workspace is "conducted" iff it has a persisted ConductorConfig; there
 * is no separate `conducted` flag on Workspace itself.
 *
 * Fail-closed, but NEVER by throwing (review finding 5). This runs on every
 * ordinary session save — including the one at the end of restore() during
 * launch — for every user, conductor or not. validateMembershipChange's
 * graph check throws MalformedMembershipError on data that really does
 * occur: SessionManager.create()/restore() never de-duplicate workspaceIds,
 * and the 2026-08-workspaces-firstclass migration can map two case-variant
 * set names onto one id, so `workspaceIds: ['a','a']` is reachable. A
 * session save must not be the thing that fails because of it. Three
 * defences, in order: return early when nothing is conducted (there is no
 * rule to enforce); de-duplicate before validating; and wrap the whole pass
 * so any throw at all logs and saves the caller's list unchanged.
 *
 * When the rule does apply, a session whose proposed workspaceIds would
 * violate exclusivity has every conducted workspace AFTER THE FIRST clamped
 * off (the same choice validateRoster's caller effectively already made by
 * proposing the earlier one first); every non-conducted membership, and a
 * workspace id that no longer exists at all, passes through unexamined.
 */
export function enforceMembershipExclusivity(
  sessions: readonly PersistedSession[],
  workspaces: readonly Workspace[],
  conductorConfigs: readonly ConductorConfig[]
): PersistedSession[] {
  // No conducted workspace ⇒ no exclusivity rule to enforce, and nothing
  // this function could legitimately change. The overwhelmingly common
  // case, and the one finding 5 was actually observed throwing in.
  if (!conductorConfigs || conductorConfigs.length === 0) return [...sessions]
  if (!sessions.some((s) => s.workspaceIds && s.workspaceIds.length > 1)) return [...sessions]

  try {
    return clampMemberships(sessions, workspaces, conductorConfigs)
  } catch (error) {
    // Logged, never rethrown: an unenforced exclusivity rule is a conductor
    // inconvenience; a throwing saveSessions loses the user's session list.
    console.warn('[crew] conductor membership check failed; saving sessions unchanged:', error)
    return [...sessions]
  }
}

function clampMemberships(
  sessions: readonly PersistedSession[],
  workspaces: readonly Workspace[],
  conductorConfigs: readonly ConductorConfig[]
): PersistedSession[] {
  const knownWorkspaceIds = new Set(workspaces.map((w) => w.id))
  const conductedIds = new Set(conductorConfigs.map((c) => c.workspaceId))
  const membershipWorkspaces: MembershipWorkspace[] = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    conducted: conductedIds.has(w.id)
  }))
  const originalWorkspaceIds: string[][] = sessions.map((s) => s.workspaceIds ?? [])
  // A workspace id the graph does not recognise would make
  // validateMembershipChange's own graph check throw, so it is filtered out
  // of the copy fed to validation ONLY. saveSessions is a hot, shared path
  // used by the whole app, not just conductor — an unknown id (stale,
  // deleted concurrently, whatever) must round-trip untouched, not get
  // silently dropped by this enforcement pass. The clamp below is applied
  // to the ORIGINAL ids, so a genuine conflict is still removed and
  // anything else — known non-conducted, or unknown entirely — survives.
  //
  // De-duplicated for the same reason (finding 5): a session legitimately
  // reaches here with the same id listed twice, and the graph check treats
  // that as malformed. A duplicate says nothing about exclusivity — one
  // membership named twice is still one membership — so collapsing it is
  // the honest reading, not a workaround.
  const validationWorkspaceIds: string[][] = originalWorkspaceIds.map((ids) =>
    [...new Set(ids)].filter((id) => knownWorkspaceIds.has(id))
  )
  // Duplicate session ids are likewise rejected by the graph check. Only
  // the first occurrence of an id goes into the validation graph; the
  // clamp below still runs for every session in the caller's list.
  const seenSessionIds = new Set<string>()
  const membershipSessions: MembershipSession[] = []
  sessions.forEach((s, index) => {
    if (seenSessionIds.has(s.id)) return
    seenSessionIds.add(s.id)
    membershipSessions.push({
      id: s.id,
      label: s.label,
      workspaceIds: validationWorkspaceIds[index]
    })
  })

  return sessions.map((session, index) => {
    const original = originalWorkspaceIds[index]
    const verdict = validateMembershipChange(membershipWorkspaces, membershipSessions, {
      sessionId: session.id,
      nextWorkspaceIds: validationWorkspaceIds[index]
    })
    const kept = verdict.ok
      ? original
      : original.filter((id) => !verdict.conflicts.some((c) => c.otherWorkspaceId === id))

    const unchanged = original.length === kept.length && original.every((id, i) => id === kept[i])
    return unchanged ? session : { ...session, workspaceIds: kept }
  })
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
  // conductorConfigs/conductorLanes are validated per-record, not here (see
  // filterValid in readFrom): a single malformed lane must not quarantine the
  // whole store. But an absent key defaults to [] for back-compat with a
  // store written before this field existed, while a *present* non-array
  // value is not "empty", it's corrupt — treating it as absent would erase
  // the collection and the very next persist() would cement that loss. So
  // only the top-level shape is checked here, and only to route corruption
  // through the normal invalid-store recovery path like every other field.
  for (const key of ['conductorConfigs', 'conductorLanes'] as const) {
    const value = raw[key]
    if (value !== undefined && !Array.isArray(value)) {
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
  private lastSerialized: string | undefined
  private backupSerialized: string | null | undefined
  private primaryFingerprint: FileFingerprint | undefined

  /** onError may run during construction; saves retain unsaved memory on failure. */
  constructor(private readonly path: string, private readonly onError?: (message: string) => void) {
    const { data, migrated, serialized, fingerprint } = this.load()
    this.data = data
    this.lastSerialized = serialized
    this.primaryFingerprint = fingerprint
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
   * still report through onError and remain dirty for the next save/batch.
   * Strict Custom View mutations reject before execution inside a batch. */
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

  private load(): { data: StoreData; migrated: boolean; serialized?: string; fingerprint?: FileFingerprint } {
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
    const recover = (
      candidate: string
    ): { data: StoreData; migrated: boolean; serialized?: string; fingerprint?: FileFingerprint } | undefined => {
      let recovered: { data: StoreData; migrated: boolean; serialized: string; fingerprint: FileFingerprint }
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
      return { data: recovered.data, migrated: true, serialized: recovered.serialized }
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
  private readFrom(path: string): { data: StoreData; migrated: boolean; serialized: string; fingerprint: FileFingerprint } {
    const serialized = readFileSync(path, 'utf8')
    const raw = parseStore(serialized)
    const stats = statSync(path)
    const data: StoreData = {
      characters: raw.characters ?? {},
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      recentDirs: raw.recentDirs ?? [],
      sessions: raw.sessions ?? [],
      sets: raw.sets ?? [],
      workspaces: raw.workspaces ?? [],
      customViews: raw.customViews ?? [],
      agents: raw.agents ?? [],
      conductorConfigs: filterValid(raw.conductorConfigs, isValidConductorConfig),
      conductorLanes: filterValid(raw.conductorLanes, isValidConductorLane),
      windowBounds: raw.windowBounds,
      migrations: [...(raw.migrations ?? [])]
    }
    const migrated = runMigrations(data)
    return { data, migrated, serialized, fingerprint: { size: stats.size, mtimeMs: stats.mtimeMs } }
  }

  private persist(options: PersistInternalOptions = {}): void {
    const throwOnFailure = options.throwOnFailure ?? false
    this.dirty = true
    if (this.batch) return
    if (this.saveBlocked) {
      const error = new Error(`failed to persist store: ${this.saveBlocked}`)
      if (throwOnFailure) throw error
      this.report(error.message)
      return
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      this.refreshPrimaryCacheForRotation()
      // Keep the previous good copy before overwriting. The roster is the only
      // record of which conversation each session maps to, and it is rewritten
      // on nearly every event — so a single bad write (or a bug that prunes the
      // list) would otherwise be unrecoverable. Cheap insurance: one .bak, one
      // .bak2, rotated on each save.
      this.rotateBackups()
      // Compact rather than pretty-printed. This is machine-written state that
      // is rewritten constantly; the indentation cost real bytes on every
      // fsync for the benefit of nobody.
      const serialized = JSON.stringify(this.data)
      atomicWriteFile(this.path, serialized)
      this.lastSerialized = serialized
      const stats = statSync(this.path)
      this.primaryFingerprint = { size: stats.size, mtimeMs: stats.mtimeMs }
      this.dirty = false
    } catch (err) {
      if (throwOnFailure) throw err
      // Non-fatal: persistence is best-effort. Losing labels between runs is
      // preferable to crashing the app on a read-only disk — but surface it.
      this.report('failed to persist store; changes remain in memory', err)
    }
  }

  private mutateCustomViewsDurably<T>(mutate: () => T): T {
    if (this.batch) {
      throw new Error('strict custom view mutations cannot run inside batchUpdates')
    }
    const previous = structuredClone(this.data.customViews)
    const wasDirty = this.dirty
    let previousPrimary: Buffer | undefined
    try {
      previousPrimary = readFileSync(this.path)
    } catch (error) {
      if (!isMissing(error)) {
        this.report('failed to prepare custom view mutation; no changes were applied', error)
        throw error
      }
    }
    let result: T
    try {
      result = mutate()
      this.persist({ throwOnFailure: true })
      return result
    } catch (error) {
      const published = error instanceof AtomicWriteError &&
        error.path === this.path &&
        error.published
      if (published) {
        const committed = Buffer.from(JSON.stringify(this.data))
        try {
          this.restorePrimary(previousPrimary)
        } catch (rollbackError) {
          const recovery = this.publishPrimary(committed)
          if (recovery !== 'failed') {
            this.dirty = recovery === 'uncertain'
            this.report(
              recovery === 'uncertain'
                ? 'custom view mutation remains committed in memory and on disk; directory durability is uncertain'
                : 'custom view mutation remains committed because rollback failed; the new store was republished durably',
              rollbackError
            )
            return result!
          }
          this.data.customViews = previous
          this.dirty = wasDirty
          this.report(
            'custom view mutation was rolled back in memory and on disk, but rollback durability could not be confirmed',
            rollbackError
          )
          throw error
        }
      }
      this.data.customViews = previous
      this.dirty = wasDirty
      this.report(
        published
          ? 'failed to confirm custom view store durability after publication; mutation rolled back'
          : 'failed to persist custom view store before publication; mutation rolled back',
        error
      )
      throw error
    }
  }

  private restorePrimary(previous: Buffer | undefined): void {
    if (previous !== undefined) {
      atomicWriteFile(this.path, previous)
      this.lastSerialized = previous.toString('utf8')
      const stats = statSync(this.path)
      this.primaryFingerprint = { size: stats.size, mtimeMs: stats.mtimeMs }
      return
    }
    try {
      unlinkSync(this.path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    syncParentDirectory(this.path)
    this.lastSerialized = undefined
    this.primaryFingerprint = undefined
  }

  private publishPrimary(contents: Buffer): 'durable' | 'uncertain' | 'failed' {
    try {
      atomicWriteFile(this.path, contents)
      this.lastSerialized = contents.toString('utf8')
      const stats = statSync(this.path)
      this.primaryFingerprint = { size: stats.size, mtimeMs: stats.mtimeMs }
      return 'durable'
    } catch {
      try {
        if (!readFileSync(this.path).equals(contents)) return 'failed'
        this.lastSerialized = contents.toString('utf8')
        const stats = statSync(this.path)
        this.primaryFingerprint = { size: stats.size, mtimeMs: stats.mtimeMs }
        return 'uncertain'
      } catch {
        return 'failed'
      }
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
  private previousBackupSerialized(): string | null {
    if (this.backupSerialized !== undefined) return this.backupSerialized
    try {
      const contents = readFileSync(`${this.path}.bak`, 'utf8')
      parseStore(contents)
      this.backupSerialized = contents
    } catch (err) {
      if (err instanceof InvalidStoreError) this.report('skipping corrupt store rotation', err)
      else if (!isMissing(err)) throw err
      this.backupSerialized = null
    }
    return this.backupSerialized
  }

  private skipCachedPrimary(message: string, err?: unknown): void {
    this.lastSerialized = undefined
    this.primaryFingerprint = undefined
    this.report(message, err)
  }

  private refreshPrimaryCacheForRotation(): void {
    if (!this.primaryFingerprint || this.lastSerialized === undefined) return
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(this.path)
    } catch (err) {
      this.skipCachedPrimary(
        isMissing(err)
          ? 'store file disappeared before backup rotation; skipping rotation for this save'
          : 'could not inspect store before backup rotation; skipping rotation for this save',
        err
      )
      return
    }
    if (stats.size === this.primaryFingerprint.size && stats.mtimeMs === this.primaryFingerprint.mtimeMs) return
    try {
      const serialized = readFileSync(this.path, 'utf8')
      parseStore(serialized)
      const refreshed = statSync(this.path)
      this.lastSerialized = serialized
      this.primaryFingerprint = { size: refreshed.size, mtimeMs: refreshed.mtimeMs }
    } catch (err) {
      this.skipCachedPrimary(
        'live store changed outside Crew but could not be validated; skipping backup rotation for this save',
        err
      )
    }
  }

  /**
   * Rotate the previous good copy into `.bak`, and the one before that into
   * `.bak2`.
   *
   * These are written WITHOUT fsync, which is where almost all of the old cost
   * of a save lived: two fsynced atomic writes, ~16ms of the ~24ms total. The
   * live store below still fsyncs, so committed state survives a crash. The
   * backups do not need the same guarantee - each one is a superseded copy, and
   * the temp-file + rename is still atomic, so the worst a power failure can do
   * is leave a backup one generation stale. It can never leave a partial file.
   *
   * The backups exist to recover from a corrupt primary or a bug that prunes
   * the roster, and neither of those is a durability problem.
   */
  private rotateBackups(): void {
    const primary = this.lastSerialized
    if (primary === undefined) return
    const previous = this.previousBackupSerialized()
    if (previous) atomicWriteFile(`${this.path}.bak2`, previous, { fsync: false })
    atomicWriteFile(`${this.path}.bak`, primary, { fsync: false })
    this.backupSerialized = primary
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
    this.data.sessions = enforceMembershipExclusivity(list, this.data.workspaces, this.data.conductorConfigs)
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

  /** Per-workspace Conductor settings. Modelled on getWorkspaces/saveWorkspaces:
   * same shallow storage, same persist-then-return shape. Malformed records
   * are dropped on load (see isValidConductorConfig), never coerced. */
  getConductorConfigs(): ConductorConfig[] {
    return this.data.conductorConfigs
  }

  saveConductorConfigs(list: ConductorConfig[]): ConductorConfig[] {
    this.data.conductorConfigs = list
    this.persist()
    return this.data.conductorConfigs
  }

  /** The lane roster. Persisting it here — rather than leaving it as the
   * in-memory Map conductor-ipc.ts used to keep — is what stops an app
   * restart from orphaning every lane worktree and every lane session.
   * Malformed records are dropped on load (see isValidConductorLane), never
   * coerced. */
  getConductorLanes(): ConductorLane[] {
    return this.data.conductorLanes
  }

  saveConductorLanes(list: ConductorLane[]): ConductorLane[] {
    this.data.conductorLanes = list
    this.persist()
    return this.data.conductorLanes
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
      groupBy: normalized.groupBy ?? 'none',
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
      groupBy: normalized.groupBy ?? 'none',
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
