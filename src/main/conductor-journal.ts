// The publication journal. Deliberately NOT part of the store: store.ts
// quarantines the whole file on corruption, and this is the most frequently
// written and most corruption-exposed data in the feature. A damaged journal
// must not cost the user their session roster.

import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFile } from './atomic-file'

export type JournalPhase =
  | 'intent'      // written before anything runs
  | 'merged'      // written after the merge produces a commit, before the CAS
  | 'tests'       // written when the test phase starts
  | 'published'   // written after the CAS succeeds, before any dependent effect
  | 'notified'    // written after teammates are told
  | 'aborted'     // written when the operation gave up cleanly

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

class JournalCorruptError extends Error {
  constructor(path: string, cause: unknown) {
    super(`conductor journal at ${path} is corrupt: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'JournalCorruptError'
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
    return parsed as JournalEntry[]
  }

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
