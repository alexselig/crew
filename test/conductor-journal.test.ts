import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal, JOURNAL_MAX_ENTRIES, JournalCorruptError, JournalInvalidEntryError } from '../src/main/conductor-journal'
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

  // --- Semantic validation (fix round 2) ---------------------------------
  // The validator must reject values recovery cannot act on, not merely
  // values of the wrong primitive type. Each read() case below has a
  // matching append() case asserting the file is left untouched, since
  // append() must reject before writing anything.

  it('throws naming the field for an empty-string id on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), opId: '' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "opId"/)
  })

  it('rejects an empty-string id on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append(intent(''))).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('throws naming the field for a "merged" entry missing resultSha on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), phase: 'merged' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "resultSha"/)
  })

  it('rejects a "merged" entry missing resultSha on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'merged' })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('throws naming the field for a "published" entry missing resultSha on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), phase: 'published' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "resultSha"/)
  })

  it('rejects a "published" entry missing resultSha on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'published' })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  // Fix round 3: narrowed to exactly 'merged'/'published' (the reviewer's
  // finding), so 'tests' and 'notified' — which Task 8 writes without a
  // resultSha at least some of the time — must be accepted without one.
  it('accepts a "tests" entry with no resultSha', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'tests' })).not.toThrow()
    expect(journal.read()[0].resultSha).toBeUndefined()
  })

  it('accepts a "notified" entry with no resultSha', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'notified' })).not.toThrow()
    expect(journal.read()[0].resultSha).toBeUndefined()
  })

  it('throws naming the field for an "aborted" entry missing detail on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), phase: 'aborted' }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "detail"/)
  })

  it('rejects an "aborted" entry missing detail on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'aborted' })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('accepts an "aborted" entry with detail and no resultSha (abort before any merge)', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'aborted', detail: 'lane deleted' })).not.toThrow()
    expect(journal.read()).toHaveLength(1)
  })

  // Fix round 3: an operation can abort BEFORE the base/lane tip are pinned
  // (Task 8's catch-handler writes baseSha: '', laneTip: '' in that case),
  // so 'aborted' is the one phase where empty shas are meaningful, not
  // corruption.
  it('accepts an "aborted" entry with empty baseSha/laneTip, and it round-trips through read()', () => {
    const journal = createJournal(path)
    journal.append({
      ...intent('op-1'), phase: 'aborted', baseSha: '', laneTip: '', detail: 'aborted before pinning'
    })
    const entries = journal.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ phase: 'aborted', baseSha: '', laneTip: '', detail: 'aborted before pinning' })
  })

  // The exception is scoped to 'aborted' only: any other phase with an
  // empty baseSha (or laneTip) must still be rejected, proving this isn't a
  // general hole in the non-empty-string rule.
  it('rejects a non-"aborted" phase with an empty baseSha', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', baseSha: '' }))
      .toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('rejects a non-"aborted" phase with an empty laneTip', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), phase: 'merged', resultSha: 'ccc', laneTip: '' }))
      .toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('throws naming the field for a negative "at" on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), at: -1 }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "at"/)
  })

  it('rejects a negative "at" on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), at: -1 })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('throws naming the field for a fractional "at" on read', () => {
    writeFileSync(path, JSON.stringify([{ ...intent('op-1'), at: 1.5 }]))
    expect(() => createJournal(path).read()).toThrow(/entry 0 field "at"/)
  })

  it('rejects a fractional "at" on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), at: 1.5 })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  // NaN cannot round-trip through JSON.parse (it becomes an error or null
  // depending on how it got there), so the read-side case is exercised via
  // JSON.stringify's own behavior: an unvalidated append would have let
  // JSON.stringify silently turn `at: NaN` into `null` in the file, which
  // is exactly the self-corruption this fix closes. We assert the append
  // rejects it outright, before any stringify/write happens.
  it('rejects a NaN "at" on append without writing the file (would otherwise serialize to null)', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), at: NaN })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('rejects an Infinity "at" on append without writing the file', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), at: Infinity })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('throws naming the field for an Infinity "at" on read (a hand-edited file, not appended)', () => {
    // JSON has no Infinity literal, so this can only reach read() via a
    // hand-edited or externally-written file — write the array as text
    // with a bare `Infinity` token rather than going through JSON.stringify.
    writeFileSync(path, `[{"opId":"op-1","laneId":"lane-1","phase":"intent","baseSha":"aaa","laneTip":"bbb","at":Infinity}]`)
    expect(() => createJournal(path).read()).toThrow(JournalCorruptError)
  })

  it('does not write the file at all when append() rejects an invalid entry, leaving no file behind', () => {
    const journal = createJournal(path)
    expect(() => journal.append({ ...intent('op-1'), laneId: '' })).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('leaves prior entries unchanged when a later append() call is rejected', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    const before = readFileSync(path, 'utf8')
    expect(() => journal.append({ ...intent('op-2'), baseSha: '' })).toThrow(JournalInvalidEntryError)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(journal.read()).toHaveLength(1)
  })

  it('throws JournalInvalidEntryError, not JournalCorruptError, for a bad append() argument', () => {
    const journal = createJournal(path)
    try {
      journal.append({ ...intent('op-1'), opId: '' })
      throw new Error('expected append to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(JournalInvalidEntryError)
      expect(error).not.toBeInstanceOf(JournalCorruptError)
    }
  })

  // Fix round 4: exotic objects with throwing getters or Proxies must not
  // escape as arbitrary errors. The validator wraps property inspection to
  // ensure that any error raised while inspecting the entry is converted to
  // a violation string, preserving the normal typed rejection path. This is
  // the load-bearing test: append() with a throwing getter must throw
  // JournalInvalidEntryError (not an arbitrary Error), and the file must be
  // left unchanged.
  it('converts a throwing getter to a violation and throws JournalInvalidEntryError on append', () => {
    const journal = createJournal(path)
    const obj: Record<string, unknown> = { laneId: 'lane-1', phase: 'intent', baseSha: 'aaa', laneTip: 'bbb', at: 1 }
    Object.defineProperty(obj, 'opId', {
      get() {
        throw new Error('simulated getter failure')
      },
    })
    expect(() => journal.append(obj as any)).toThrow(JournalInvalidEntryError)
    expect(() => readFileSync(path, 'utf8')).toThrow(/ENOENT/)
  })

  it('leaves the file unchanged when a throwing getter is rejected on append after a prior entry', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    const before = readFileSync(path, 'utf8')
    const obj: Record<string, unknown> = { laneId: 'lane-2', phase: 'intent', baseSha: 'aaa', laneTip: 'bbb', at: 2 }
    Object.defineProperty(obj, 'opId', {
      get() {
        throw new Error('simulated getter failure')
      },
    })
    expect(() => journal.append(obj as any)).toThrow(JournalInvalidEntryError)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(journal.read()).toHaveLength(1)
  })
})
