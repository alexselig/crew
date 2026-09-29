// The publication journal. Deliberately NOT part of the store: store.ts
// quarantines the whole file on corruption, and this is the most frequently
// written and most corruption-exposed data in the feature. A damaged journal
// must not cost the user their session roster.

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-file'

export const JOURNAL_PHASES = [
  'intent',    // written before anything runs
  'merged',    // written after the merge produces a commit, before the CAS
  'tests',     // written when the test phase starts
  'published', // written after the CAS succeeds, before any dependent effect
  'notified',  // written after teammates are told
  'aborted',   // written when the operation gave up cleanly
] as const

export type JournalPhase = typeof JOURNAL_PHASES[number]

export interface JournalEntry {
  opId: string
  laneId: string
  phase: JournalPhase
  baseSha: string
  laneTip: string
  /**
   * Required on 'merged' and 'published' — the two phases whose meaning IS
   * the sha they produced. Optional (may be present or absent) on every
   * other phase, including 'tests' and 'notified', which may carry one
   * through for convenience without depending on it — see
   * PHASES_REQUIRING_RESULT_SHA.
   */
  resultSha?: string
  /** Free-text reason. Required on 'aborted', optional elsewhere. */
  detail?: string
  at: number
}

export const JOURNAL_MAX_ENTRIES = 500

export interface Journal {
  append(entry: JournalEntry): void
  read(): JournalEntry[]
  entriesFor(opId: string): JournalEntry[]
}

export class JournalCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`conductor journal at ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'JournalCorruptError'
  }
}

/**
 * Thrown by append() when the caller hands it an entry the validator
 * rejects. Deliberately distinct from JournalCorruptError: a bad append
 * argument is a programming error in this process, not evidence that the
 * on-disk file is damaged. Keeping the two separate lets a caller (or a
 * test) tell "my in-memory entry was malformed" apart from "the file on
 * disk cannot be trusted" without inspecting message text.
 */
export class JournalInvalidEntryError extends Error {
  constructor(cause: string) {
    super(`invalid journal entry: ${cause}`)
    this.name = 'JournalInvalidEntryError'
  }
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isNonEmptyString = (v: unknown): v is string => isString(v) && v.length > 0

// Only 'merged' and 'published' have a resultSha whose presence IS the
// phase's meaning: 'merged' records the commit the merge produced, and
// 'published' records the commit the CAS landed. 'tests' and 'notified'
// happen later in the same operation and may carry a resultSha (Task 8
// passes one through for convenience), but neither phase's meaning depends
// on it, so it must not be required there — requiring it would reject
// entries the feature's own call sites are allowed to write.
const PHASES_REQUIRING_RESULT_SHA: ReadonlySet<JournalPhase> = new Set([
  'merged', 'published',
])

/**
 * Throws a description naming the offending entry index and field, never
 * "corrupt" alone: a user staring at a stack trace needs to find the entry.
 * Guards every interpolation against undefined so error construction itself
 * cannot throw. Semantic, not just type-based: recovery reconciles an
 * interrupted run against git reality using these values, so an entry with
 * the right primitive types but a meaningless value (empty id, a phase
 * whose sha is missing, a non-integer timestamp) is just as unusable as one
 * with the wrong type, and must fail closed the same way.
 * 
 * Property inspection itself is wrapped to prevent exotic objects (with
 * throwing getters or Proxies) from escaping as arbitrary errors: any error
 * raised while inspecting the entry is converted to a violation string.
 */
function describeEntryViolation(label: string, entry: unknown): string | undefined {
  try {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `${label} is not an object`
    }
    const e = entry as Record<string, unknown>
    if (!isNonEmptyString(e.opId)) return `${label} field "opId" is not a non-empty string`
    if (!isNonEmptyString(e.laneId)) return `${label} field "laneId" is not a non-empty string`
    if (!isString(e.phase) || !(JOURNAL_PHASES as readonly string[]).includes(e.phase)) {
      return `${label} field "phase" is not one of ${JOURNAL_PHASES.join(', ')}`
    }
    const phase = e.phase as JournalPhase
    // baseSha/laneTip must always be strings (never missing, never null), but
    // may be empty ONLY for phase 'aborted': an operation can abort before the
    // base and lane tip are ever pinned (see Task 8's catch-handler, which
    // writes 'aborted' with baseSha/laneTip '' when the failure happens before
    // step 2/3 runs), so at that point there genuinely is no sha to record.
    // Every other phase's meaning depends on these fields, so they stay
    // non-empty everywhere else — do not relax this further.
    if (!isString(e.baseSha)) return `${label} field "baseSha" is not a string`
    if (phase !== 'aborted' && !isNonEmptyString(e.baseSha)) {
      return `${label} field "baseSha" is not a non-empty string`
    }
    if (!isString(e.laneTip)) return `${label} field "laneTip" is not a string`
    if (phase !== 'aborted' && !isNonEmptyString(e.laneTip)) {
      return `${label} field "laneTip" is not a non-empty string`
    }
    if (typeof e.at !== 'number' || !Number.isInteger(e.at) || e.at < 0) {
      return `${label} field "at" is not a non-negative integer`
    }
    if (e.resultSha !== undefined && !isNonEmptyString(e.resultSha)) {
      return `${label} field "resultSha" is not a non-empty string`
    }
    if (PHASES_REQUIRING_RESULT_SHA.has(phase) && e.resultSha === undefined) {
      return `${label} field "resultSha" is required for phase "${phase}"`
    }
    if (e.detail !== undefined && !isNonEmptyString(e.detail)) {
      return `${label} field "detail" is not a non-empty string`
    }
    if (phase === 'aborted' && e.detail === undefined) {
      return `${label} field "detail" is required for phase "aborted"`
    }
    return undefined
  } catch {
    return `${label} could not be inspected`
  }
}

export function createJournal(path: string): Journal {
  const read = (): JournalEntry[] => {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Never degrade to []: an unreadable journal looks identical to "nothing
      // happened", which would classify an interrupted publication as
      // not-started and double-apply the work.
      throw new JournalCorruptError(path, error)
    }
    if (!Array.isArray(parsed)) throw new JournalCorruptError(path, 'expected an array')
    for (let i = 0; i < parsed.length; i += 1) {
      const violation = describeEntryViolation(`entry ${i}`, parsed[i])
      if (violation !== undefined) throw new JournalCorruptError(path, violation)
    }
    return parsed as JournalEntry[]
  }

  // Invariant this depends on: append() is fully synchronous (no await
  // between the read and the write), and only one workspace conducts at a
  // time, with publication additionally serialized by the publication lock.
  // That rules out any interleaving within or across the processes that can
  // reach this file, so the read-modify-rewrite below needs no lock, retry,
  // or CAS. If append() is ever made async, this invariant breaks and a
  // locking scheme becomes necessary.
  const append = (entry: JournalEntry): void => {
    // Validate the input BEFORE any read or write: the same rules read()
    // enforces on disk apply to what we're about to write, so a caller
    // cannot self-corrupt the file (e.g. via JSON.stringify(NaN) -> null,
    // silently unrecoverable on the next read) or write an entry recovery
    // could never act on. Rejecting here, before mkdirSync/atomicWriteFile,
    // guarantees the file on disk is untouched when this throws.
    const violation = describeEntryViolation('entry', entry)
    if (violation !== undefined) {
      throw new JournalInvalidEntryError(violation.replace(/^entry /, ''))
    }
    const entries = read()
    entries.push(entry)
    const bounded = entries.length > JOURNAL_MAX_ENTRIES
      ? entries.slice(entries.length - JOURNAL_MAX_ENTRIES)
      : entries
    mkdirSync(dirname(path), { recursive: true })
    // Throws on failure by design (AtomicWriteError). The caller must abort
    // the effect rather than proceed with an unrecorded mutation of a shared ref.
    atomicWriteFile(path, JSON.stringify(bounded, null, 2))
  }

  const entriesFor = (opId: string): JournalEntry[] => read().filter((e) => e.opId === opId)

  return { append, read, entriesFor }
}
