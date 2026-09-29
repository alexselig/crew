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
   * Only knowable after the merge has run: absent on 'intent' and optional
   * on 'aborted' (an abort can happen before any merge runs), but required
   * on every other phase — see PHASES_REQUIRING_RESULT_SHA.
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

// Phases written strictly after the merge has produced a commit: their
// resultSha is already known by the time they are written (see the
// JOURNAL_PHASES comments above — 'merged' is written once the merge
// produces a commit, and 'tests'/'published'/'notified' all happen later
// in the same operation), so resultSha is required on all of them, not just
// on the two phases the finding named explicitly ('merged'/'published').
// 'aborted' can legitimately happen before a merge ever runs (e.g. an abort
// during 'intent'), so a resultSha isn't guaranteed there and is left
// optional; this is the stricter reading where 'aborted' is ambiguous,
// since it requires 'detail' instead and does not relax any other rule.
const PHASES_REQUIRING_RESULT_SHA: ReadonlySet<JournalPhase> = new Set([
  'merged', 'tests', 'published', 'notified',
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
 */
function describeEntryViolation(label: string, entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `${label} is not an object`
  }
  const e = entry as Record<string, unknown>
  if (!isNonEmptyString(e.opId)) return `${label} field "opId" is not a non-empty string`
  if (!isNonEmptyString(e.laneId)) return `${label} field "laneId" is not a non-empty string`
  if (!isString(e.phase) || !(JOURNAL_PHASES as readonly string[]).includes(e.phase)) {
    return `${label} field "phase" is not one of ${JOURNAL_PHASES.join(', ')}`
  }
  if (!isNonEmptyString(e.baseSha)) return `${label} field "baseSha" is not a non-empty string`
  if (!isNonEmptyString(e.laneTip)) return `${label} field "laneTip" is not a non-empty string`
  if (typeof e.at !== 'number' || !Number.isInteger(e.at) || e.at < 0) {
    return `${label} field "at" is not a non-negative integer`
  }
  if (e.resultSha !== undefined && !isNonEmptyString(e.resultSha)) {
    return `${label} field "resultSha" is not a non-empty string`
  }
  const phase = e.phase as JournalPhase
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
