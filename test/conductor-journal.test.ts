import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal, JOURNAL_MAX_ENTRIES } from '../src/main/conductor-journal'

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

  it('writes valid JSON a human can read during an incident', () => {
    const journal = createJournal(path)
    journal.append(intent('op-1'))
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
  })
})
