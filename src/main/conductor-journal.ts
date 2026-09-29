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
  /** Only knowable after the merge has run. Absent on 'intent'. */
  resultSha?: string
  /** Free-text reason, for 'aborted'. */
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

const isString = (v: unknown): v is string => typeof v === 'string'
const isNumber = (v: unknown): v is number => typeof v === 'number'

/**
 * Throws a description naming the offending entry index and field, never
 * "corrupt" alone: a user staring at a stack trace needs to find the entry.
 * Guards every interpolation against undefined so error construction itself
 * cannot throw.
 */
function describeShapeViolation(index: number, entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return `entry ${index} is not an object`
  }
  const e = entry as Record<string, unknown>
  if (!isString(e.opId)) return `entry ${index} field "opId" is not a string`
  if (!isString(e.laneId)) return `entry ${index} field "laneId" is not a string`
  if (!isString(e.phase) || !(JOURNAL_PHASES as readonly string[]).includes(e.phase)) {
    return `entry ${index} field "phase" is not one of ${JOURNAL_PHASES.join(', ')}`
  }
  if (!isString(e.baseSha)) return `entry ${index} field "baseSha" is not a string`
  if (!isString(e.laneTip)) return `entry ${index} field "laneTip" is not a string`
  if (!isNumber(e.at)) return `entry ${index} field "at" is not a number`
  if (e.resultSha !== undefined && !isString(e.resultSha)) {
    return `entry ${index} field "resultSha" is not a string`
  }
  if (e.detail !== undefined && !isString(e.detail)) {
    return `entry ${index} field "detail" is not a string`
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
      const violation = describeShapeViolation(i, parsed[i])
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
