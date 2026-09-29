import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal, JOURNAL_MAX_ENTRIES, JournalCorruptError } from '../src/main/conductor-journal'
import { AtomicWriteError } from '../src/main/atomic-file'

let root: string
let path: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crew-journal-'))
  path = join(root, 'conductor-journal.json')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const intent = (opId: string) => ({
  opId, laneId: 'lane-1', phase: 'intent' as const,
  baseSha: 'aaa', laneTip: 'bbb', at: 1
})

describe('journal', () => {
  it('reads empty when the file does not exist', () => {
    expect(createJournal(path).read()).toEqual([])
  })

  it('appends and reads back in order', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', at: 2 })
    const entries = journal.read()
    expect(entries.map((e) => e.phase)).toEqual(['intent', 'merged'])
    expect(entries[1].resultSha).toBe('ccc')
  })

  // The resulting SHA does not exist until the merge has run, so one write
  // leaves "committed but unrecorded" unclassifiable.
  it('records intent and result as two separate entries for one operation', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', at: 2 })
    journal.append(intent('op-2'))
    const forOp = journal.entriesFor('op-1')
    expect(forOp).toHaveLength(2)
    expect(forOp.every((e) => e.opId === 'op-1')).toBe(true)
  })

  it('survives a new instance reading the same file', () => {
    createJournal(path).append(intent('op-1'))
    expect(createJournal(path).read()).toHaveLength(1)
  })

  it('bounds the file, discarding the oldest entries', () => {
    const journal = createJournal(path)
    for (let i = 0; i < JOURNAL_MAX_ENTRIES + 25; i += 1) {
      journal.append({ ...intent(`op-${i}`), at: i })
    }
    const entries = journal.read()
    expect(entries).toHaveLength(JOURNAL_MAX_ENTRIES)
    expect(entries[0].opId).toBe('op-25')
  })

  // A damaged journal must not cost the user anything else, and must not be
  // silently treated as "nothing happened" — that would classify an
  // interrupted publication as not-started and double-apply it.
  it('throws on a corrupt journal rather than reporting an empty one', () => {
    writeFileSync(path, '{not json')
    expect(() => createJournal(path).read()).toThrow(/corrupt/i)
  })

  it('throws a JournalCorruptError on a corrupt journal', () => {
    writeFileSync(path, '{not json')
    expect(() => createJournal(path).read()).toThrow(JournalCorruptError)
  })

  it('throws on a zero-byte file rather than reporting an empty journal', () => {
    writeFileSync(path, '')
    expect(() => createJournal(path).read()).toThrow(JournalCorruptError)
  })

  it('throws on a truncated tail (valid prefix, cut mid-entry)', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    const full = readFileSync(path, 'utf8')
    writeFileSync(path, full.slice(0, Math.floor(full.length / 2)))
    expect(() => createJournal(path).read()).toThrow(JournalCorruptError)
  })

  it('throws on garbage in the middle of an otherwise valid file', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    const full = readFileSync(path, 'utf8')
    const mid = Math.floor(full.length / 2)
    writeFileSync(path, full.slice(0, mid) + '###GARBAGE###' + full.slice(mid))
    expect(() => createJournal(path).read()).toThrow(JournalCorruptError)
  })

  it('throws on valid JSON of the wrong top-level shape (an object, not an array)', () => {
    writeFileSync(path, JSON.stringify({ opId: 'op-1' }))
    expect(() => createJournal(path).read()).toThrow(/expected an array/i)
  })

  it('throws naming the entry index and field for an empty-object entry', () => {
    writeFileSync(path, JSON.stringify([{}]))
    expect(() => createJournal(path).read()).toThrow(/entry 0/)
  })

  it('throws naming the entry and field for an invalid phase value', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), phase: 'not-a-real-phase' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "phase"/)
  })

  it('throws naming the entry and field for a wrong primitive type', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), at: 'not-a-number' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "at"/)
  })

  it('identifies the specific bad entry when a later entry is malformed', () => {
    writeFileSync(path, JSON.stringify([intent('op-1'), { ...intent('op-2'), laneId: 42 }]))
    expect(() => createJournal(path).read()).toThrow(/entry 1 field "laneId"/)
  })

  // Persistence failure must fail closed and prevent the effect, rather than
  // reporting success from memory as the store's best-effort save does.
  it('throws when the write fails, so the caller aborts the effect', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    chmodSync(root, 0o500)
    try {
      expect(() => journal.append(intent('op-2'))).toThrow()
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('throws an AtomicWriteError (not a JournalCorruptError) on a write failure', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    chmodSync(root, 0o500)
    try {
      expect(() => journal.append(intent('op-2'))).toThrow(AtomicWriteError)
      try {
        journal.append(intent('op-2'))
        throw new Error('expected append to throw')
      } catch (error) {
        expect(error).not.toBeInstanceOf(JournalCorruptError)
      }
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('writes valid JSON a human can read during an incident', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
  })
})
