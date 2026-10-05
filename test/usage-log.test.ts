// Opt-in, local-only usage insights.
//
// Two properties are load-bearing and are what these tests actually guard:
//
//  1. Silence by default. With consent off, nothing is written — not a file,
//     not an empty file. Opt-in that still creates artefacts is not opt-in.
//  2. Free text is structurally impossible, not merely discouraged. The
//     recorder takes counters, durations and values from fixed allow-lists;
//     a prompt, a path or a line of terminal output cannot be smuggled into
//     the log even by a caller that wants to, because there is no field that
//     accepts arbitrary strings.
//
// Everything stays on the machine: an append-only JSONL file in the app's
// own data directory, readable by the user, wipeable in one call. Crew has
// no analytics dependency and this must not introduce one.
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageLog } from '../src/main/usage-log'

const temporaryDirs: string[] = []
function tmpLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-usage-'))
  temporaryDirs.push(dir)
  return join(dir, 'usage.jsonl')
}
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('opt-in usage insights', () => {
  describe('consent', () => {
    it('is off unless it is switched on', () => {
      const log = new UsageLog(tmpLogPath())
      expect(log.enabled).toBe(false)
    })

    it('writes nothing at all while off — not even an empty file', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path)
      log.record('session.opened')
      log.record('session.prompt')
      expect(existsSync(path)).toBe(false)
      expect(log.summary().totals['session.opened'] ?? 0).toBe(0)
    })

    it('records once consent is given', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      expect(lines(path)).toHaveLength(1)
    })

    it('stops recording the moment consent is withdrawn', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      log.setEnabled(false)
      log.record('session.opened')
      expect(lines(path)).toHaveLength(1)
    })

    it('keeps what was already recorded when consent is withdrawn, so the user can still read or wipe it', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.prompt')
      log.setEnabled(false)
      expect(log.summary().totals['session.prompt']).toBe(1)
    })
  })

  describe('what may be recorded', () => {
    it('stamps each event with a time and a name and nothing else by default', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      const [row] = lines(path)
      expect(Object.keys(row).sort()).toEqual(['e', 't'])
      expect(row.e).toBe('session.opened')
      expect(typeof row.t).toBe('number')
    })

    it('accepts a duration in milliseconds', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.dwell', { ms: 4200 })
      expect(lines(path)[0]).toMatchObject({ e: 'session.dwell', ms: 4200 })
    })

    it('accepts a count', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.prompt', { n: 3 })
      expect(lines(path)[0]).toMatchObject({ n: 3 })
    })

    it('accepts a value only from the allow-list for that event', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('view.used', { v: 'grid' })
      expect(lines(path)[0]).toMatchObject({ e: 'view.used', v: 'grid' })
    })

    // The whole point: a caller cannot write the user's prompt into the log,
    // because no field will take it.
    it('drops a value that is not on the allow-list rather than writing it', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('view.used', { v: 'refactor the auth module' as never })
      const [row] = lines(path)
      expect(row.v).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain('refactor')
    })

    it('ignores an event name it does not know', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('prompt.text' as never)
      expect(lines(path)).toHaveLength(0)
    })

    it('ignores extra fields a caller invents', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened', { cwd: '/Users/alex/secret', prompt: 'hello' } as never)
      const [row] = lines(path)
      expect(Object.keys(row).sort()).toEqual(['e', 't'])
    })

    it('refuses a duration or count that is not a finite number', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.dwell', { ms: Number.NaN })
      log.record('session.prompt', { n: '7' as never })
      const rows = lines(path)
      expect(rows[0].ms).toBeUndefined()
      expect(rows[1].n).toBeUndefined()
    })
  })

  describe('the log on disk', () => {
    it('is append-only: one JSON object per line', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      log.record('session.closed')
      const raw = readFileSync(path, 'utf8')
      expect(raw.trimEnd().split('\n')).toHaveLength(2)
      expect(raw.endsWith('\n')).toBe(true)
    })

    it('survives a reopen and keeps counting', () => {
      const path = tmpLogPath()
      new UsageLog(path, { enabled: true }).record('session.opened')
      const second = new UsageLog(path, { enabled: true })
      second.record('session.opened')
      expect(second.summary().totals['session.opened']).toBe(2)
    })

    it('skips a corrupt line rather than losing the whole history', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      require('node:fs').appendFileSync(path, 'not json\n')
      log.record('session.opened')
      expect(log.summary().totals['session.opened']).toBe(2)
    })

    it('reports where the file lives, so the user can go and read it', () => {
      const path = tmpLogPath()
      expect(new UsageLog(path).path).toBe(path)
    })
  })

  describe('wiping', () => {
    it('removes the file in one call', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      log.wipe()
      expect(existsSync(path)).toBe(false)
      expect(log.summary().totals).toEqual({})
    })

    it('leaves consent alone, so wiping is not the same as opting out', () => {
      const path = tmpLogPath()
      const log = new UsageLog(path, { enabled: true })
      log.record('session.opened')
      log.wipe()
      expect(log.enabled).toBe(true)
      log.record('session.opened')
      expect(lines(path)).toHaveLength(1)
    })

    it('is harmless when there is nothing to wipe', () => {
      const log = new UsageLog(tmpLogPath())
      expect(() => log.wipe()).not.toThrow()
    })
  })

  describe('the numbers the user gets back', () => {
    it('counts each kind of event', () => {
      const log = new UsageLog(tmpLogPath(), { enabled: true })
      log.record('session.opened')
      log.record('session.opened')
      log.record('session.prompt')
      expect(log.summary().totals).toEqual({ 'session.opened': 2, 'session.prompt': 1 })
    })

    it('adds up time spent in a session', () => {
      const log = new UsageLog(tmpLogPath(), { enabled: true })
      log.record('session.dwell', { ms: 1000 })
      log.record('session.dwell', { ms: 2500 })
      expect(log.summary().dwellMs).toBe(3500)
    })

    it('breaks down which views were used', () => {
      const log = new UsageLog(tmpLogPath(), { enabled: true })
      log.record('view.used', { v: 'grid' })
      log.record('view.used', { v: 'grid' })
      log.record('view.used', { v: 'focus' })
      expect(log.summary().views).toEqual({ grid: 2, focus: 1 })
    })

    it('reports how many days the log covers and when it starts', () => {
      const log = new UsageLog(tmpLogPath(), { enabled: true })
      log.record('session.opened')
      const s = log.summary()
      expect(s.events).toBe(1)
      expect(s.days).toBe(1)
      expect(typeof s.since).toBe('number')
    })

    it('answers with empty numbers when nothing was ever recorded', () => {
      const s = new UsageLog(tmpLogPath()).summary()
      expect(s.events).toBe(0)
      expect(s.dwellMs).toBe(0)
      expect(s.days).toBe(0)
      expect(s.since).toBeNull()
    })

    it('reports whether an offered resume was taken, which nothing else can answer', () => {
      const log = new UsageLog(tmpLogPath(), { enabled: true })
      log.record('resume.offered')
      log.record('resume.offered')
      log.record('resume.accepted')
      const s = log.summary()
      expect(s.totals['resume.offered']).toBe(2)
      expect(s.totals['resume.accepted']).toBe(1)
    })
  })
})
