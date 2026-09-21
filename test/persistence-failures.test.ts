import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync)
  }
})

import { Store } from '../src/main/store'
import { TranscriptRecorder } from '../src/main/transcripts'
import { atomicWriteFile } from '../src/main/atomic-file'
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

let dir: string
const session = {
  id: 'one', presetId: null, command: '/bin/sh', args: [],
  cwd: '/tmp', label: 'Important session', characterId: 'lion'
}

function captureError(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected operation to throw')
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fs.openSync).mockImplementation(actualFs.openSync)
  vi.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync)
  vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
  vi.mocked(fs.writeSync).mockImplementation(actualFs.writeSync)
  vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync)
  vi.mocked(fs.readFileSync).mockImplementation(actualFs.readFileSync)
  vi.mocked(fs.readdirSync).mockImplementation(actualFs.readdirSync)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers()
  dir = fs.mkdtempSync(join(tmpdir(), 'crew-write-failure-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('atomic publication', () => {
  it('flushes a same-directory unique temporary file before replacing the primary', () => {
    const path = join(dir, 'store.json')
    fs.writeFileSync(path, 'old')
    const temporaries: string[] = []
    let fileFlushes = 0
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (actualFs.fstatSync(fd).isFile()) fileFlushes++
      actualFs.fsyncSync(fd)
    })
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      expect(target).toBe(path)
      expect(typeof source).toBe('string')
      const temporary = String(source)
      expect(temporary.startsWith(join(dir, '.store.json.'))).toBe(true)
      expect(fs.openSync).toHaveBeenCalledWith(temporary, 'wx', 0o600)
      if (process.platform !== 'win32') expect(fs.statSync(temporary).mode & 0o777).toBe(0o600)
      expect(fileFlushes).toBe(temporaries.length + 1)
      temporaries.push(temporary)
      actualFs.renameSync(source, target)
    })
    atomicWriteFile(path, 'new')
    atomicWriteFile(path, 'newer')
    expect(new Set(temporaries).size).toBe(2)
    expect(fs.readFileSync(path, 'utf8')).toBe('newer')
    expect(fs.readdirSync(dir)).toEqual(['store.json'])
  })

  it.each(['write', 'fsync', 'rename'] as const)('preserves old content and cleans temporary files after %s failure', (stage) => {
    const path = join(dir, 'store.json')
    fs.writeFileSync(path, 'last good')
    const fail = (): never => { throw new Error(`${stage} failed`) }
    if (stage === 'write') {
      vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
        actualFs.writeFileSync(file, 'partial')
        fail()
      })
    } else if (stage === 'fsync') {
      vi.mocked(fs.fsyncSync).mockImplementationOnce(fail)
    } else {
      vi.mocked(fs.renameSync).mockImplementationOnce(fail)
    }
    const error = captureError(() => atomicWriteFile(path, 'replacement'))
    expect(error).toMatchObject({
      name: 'AtomicWriteError',
      path,
      published: false,
      cause: expect.any(Error)
    })
    expect(error).toHaveProperty('message', `${stage} failed`)
    expect(fs.readFileSync(path, 'utf8')).toBe('last good')
    expect(fs.readdirSync(dir)).toEqual(['store.json'])
  })
})

describe('store atomic batches', () => {
  it('publishes a 30-session restore once and leaves the full saved roster intact during every prefix', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    store.saveSessions([session])
    const before = fs.readFileSync(path, 'utf8')
    vi.mocked(fs.renameSync).mockClear()
    const result = store.batchUpdates(() => {
      const sessions: typeof session[] = []
      for (let i = 0; i < 30; i++) {
        const next = { ...session, id: `session-${i}` }
        sessions.push(next)
        store.setAssignment(next.id, { characterId: 'lion', lastLabel: next.label })
        store.saveSessions([...sessions])
        expect(fs.readFileSync(path, 'utf8')).toBe(before)
        expect(fs.renameSync).not.toHaveBeenCalled()
      }
      return 30
    })
    expect(result).toBe(30)
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toHaveLength(30)
    expect(vi.mocked(fs.renameSync).mock.calls.filter(([, target]) => target === path)).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(`${path}.bak`, 'utf8')).sessions).toEqual([session])
  })

  it('clones only the outer snapshot and commits nested mutations together', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    const result = store.batchUpdates(() => {
      store.updateSettings({ sound: true })
      const inner = store.batchUpdates(() => {
        store.saveSessions([session])
        return 'inner result'
      })
      expect(fs.existsSync(path)).toBe(false)
      return inner
    })
    expect(result).toBe('inner result')
    expect(clone).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toMatchObject({ sessions: [session], settings: { sound: true } })
    expect(fs.renameSync).toHaveBeenCalledTimes(1)
  })

  it('deeply restores all pre-batch state on callback failure without publishing mutations', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    store.saveSessions([structuredClone(session)])
    const before = fs.readFileSync(path, 'utf8')
    const error = new Error('restore failed')
    vi.mocked(fs.renameSync).mockClear()
    expect(() => store.batchUpdates(() => {
      store.getSessions()[0].args.push('--changed')
      store.updateSettings({ sound: true })
      store.setAssignment('new', { characterId: 'fox', lastLabel: 'partial' })
      store.addRecentDir('/partial')
      store.saveSessions([])
      throw error
    })).toThrow(error)
    expect(fs.readFileSync(path, 'utf8')).toBe(before)
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(store.getSessions()).toEqual([{ ...session, args: [] }])
    expect(store.settings.sound).toBe(false)
    expect(store.getAssignment('new')).toBeUndefined()
    expect(store.recentDirs).toEqual([])
    store.updateSettings({ sound: true })
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([{ ...session, args: [] }])
  })

  it('aborts the outer batch even if its callback catches a nested callback failure', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    const error = new Error('nested restore failed')
    expect(() => store.batchUpdates(() => {
      store.saveSessions([session])
      try {
        store.batchUpdates(() => {
          store.updateSettings({ sound: true })
          throw error
        })
      } catch {
        store.addRecentDir('/still-partial')
      }
    })).toThrow(error)
    expect(fs.existsSync(path)).toBe(false)
    expect(store.getSessions()).toEqual([])
    expect(store.settings.sound).toBe(false)
    expect(store.recentDirs).toEqual([])
  })

  it('does not publish an unchanged clean batch', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    expect(store.batchUpdates(() => 'unchanged')).toBe('unchanged')
    expect(fs.existsSync(path)).toBe(false)
    expect(fs.fsyncSync).not.toHaveBeenCalled()
  })

  it('retains failed publication as dirty and retries it on the next successful batch', () => {
    const path = join(dir, 'store.json')
    const errors = vi.fn()
    const store = new Store(path, errors)
    store.saveSessions([session])
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === path) throw new Error('publication denied')
      actualFs.renameSync(source, target)
    })
    expect(store.batchUpdates(() => {
      store.saveSessions([])
      return 'callback completed'
    })).toBe('callback completed')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('publication denied'))
    expect(store.getSessions()).toEqual([])
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([session])
    vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync)
    store.batchUpdates(() => {})
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([])
    vi.mocked(fs.renameSync).mockClear()
    store.batchUpdates(() => {})
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it('preserves pre-existing unsaved changes and their retry state when a later batch rolls back', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('disk full') })
    store.saveSessions([session])
    expect(() => store.batchUpdates(() => {
      store.saveSessions([])
      throw new Error('abort')
    })).toThrow('abort')
    expect(store.getSessions()).toEqual([session])
    expect(fs.existsSync(path)).toBe(false)
    store.batchUpdates(() => {})
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([session])
  })
})

describe('store fault recovery', () => {
  it('recovers backups when the primary file is missing', () => {
    const path = join(dir, 'store.json')
    const first = new Store(path)
    first.saveSessions([session])
    first.saveSessions([session])
    fs.unlinkSync(path)
    expect(new Store(path).getSessions()).toEqual([session])
  })

  it('rejects structurally invalid JSON and recovers a healthy backup', () => {
    const path = join(dir, 'store.json')
    const first = new Store(path)
    first.saveSessions([session])
    first.saveSessions([session])
    fs.writeFileSync(path, JSON.stringify({
      ...JSON.parse(fs.readFileSync(path, 'utf8')), sessions: { not: 'an array' }
    }))
    expect(new Store(path).getSessions()).toEqual([session])
  })

  it('never truncates the primary store during a failed write', () => {
    const path = join(dir, 'store.json')
    const first = new Store(path)
    first.saveSessions([session])
    const before = fs.readFileSync(path, 'utf8')
    vi.mocked(fs.writeFileSync).mockImplementationOnce((...args) => {
      actualFs.writeFileSync(args[0], '{"sessions":')
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    })
    first.saveSessions([])
    expect(fs.readFileSync(path, 'utf8')).toBe(before)
  })

  it('reports failed publication and retains unsaved changes for retry', () => {
    const path = join(dir, 'store.json')
    const errors = vi.fn()
    const store = new Store(path, errors)
    store.saveSessions([session])
    const rename = vi.mocked(fs.renameSync).getMockImplementation()!
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === path) throw new Error('replacement denied')
      rename(source, target)
    })
    store.saveSessions([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('replacement denied'))
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([session])
    vi.mocked(fs.renameSync).mockImplementation(rename)
    store.saveSessions(store.getSessions())
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([])
  })

  it('recovers the second rotation when the primary is missing and the first rotation is corrupt', () => {
    const path = join(dir, 'store.json')
    fs.writeFileSync(`${path}.bak`, 'broken')
    fs.writeFileSync(`${path}.bak2`, JSON.stringify({ sessions: [session] }))
    expect(new Store(path).getSessions()[0].id).toBe(session.id)
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions[0].id).toBe(session.id)
  })

  it('recovers the newest healthy dated snapshot after invalid rotations and a newer corrupt snapshot', () => {
    const path = join(dir, 'store.json')
    const snapshots = join(dir, 'backups')
    fs.mkdirSync(snapshots)
    fs.writeFileSync(path, 'broken primary')
    fs.writeFileSync(`${path}.bak`, 'broken rotation')
    fs.writeFileSync(join(snapshots, 'crew-store-2026-09-10.json'), 'broken snapshot')
    fs.writeFileSync(join(snapshots, 'crew-store-2026-09-09.json'), JSON.stringify({ sessions: [session] }))
    fs.writeFileSync(join(snapshots, 'crew-store-2026-09-08.json'), JSON.stringify({ sessions: [] }))
    const errors = vi.fn()
    const store = new Store(path, errors)
    expect(store.getSessions()[0].id).toBe(session.id)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('crew-store-2026-09-09.json'))
    const quarantine = fs.readdirSync(dir).find((name) => name.includes('.corrupt-'))
    expect(quarantine).toBeDefined()
    expect(fs.readFileSync(join(dir, quarantine!), 'utf8')).toBe('broken primary')
  })

  it('does not quarantine or overwrite an inaccessible primary, even when a backup can be read', () => {
    const path = join(dir, 'store.json')
    const before = JSON.stringify({ sessions: [session] })
    fs.writeFileSync(path, before)
    fs.writeFileSync(`${path}.bak`, before)
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const errors = vi.fn()
    const store = new Store(path, errors)
    expect(store.getSessions()[0].id).toBe(session.id)
    store.saveSessions([])
    expect(fs.renameSync).not.toHaveBeenCalled()
    expect(fs.readFileSync(path, 'utf8')).toBe(before)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('saving is disabled'))
  })

  it('disables publication when preserving a corrupt primary fails', () => {
    const path = join(dir, 'store.json')
    fs.writeFileSync(path, 'recover this manually')
    fs.writeFileSync(`${path}.bak`, JSON.stringify({ sessions: [session] }))
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('quarantine denied') })
    const errors = vi.fn()
    const store = new Store(path, errors)
    expect(store.getSessions()[0].id).toBe(session.id)
    store.saveSessions([])
    expect(fs.readFileSync(path, 'utf8')).toBe('recover this manually')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('quarantine denied'))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('saving is disabled'))
  })

  it.each(['primary', 'backup'] as const)('reports irrecoverable %s data and never persists an empty replacement', (location) => {
    const path = join(dir, 'store.json')
    const damaged = location === 'primary' ? path : `${path}.bak`
    fs.writeFileSync(damaged, 'irrecoverable')
    const errors = vi.fn()
    const store = new Store(path, errors)
    store.saveSessions([session])
    expect(store.getSessions()).toEqual([session])
    expect(fs.readFileSync(damaged, 'utf8')).toBe('irrecoverable')
    if (location === 'backup') expect(fs.existsSync(path)).toBe(false)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no readable store or backup'))
    expect(fs.renameSync).not.toHaveBeenCalled()
  })

  it.each([
    null, [], 'not an object',
    { settings: [] }, { settings: { notifications: 'yes' } },
    { characters: { job: null } }, { sessions: [null] },
    { sessions: [{ ...session, args: 'bad' }] },
    { sessions: [{ ...session, workspaceIds: [12] }] },
    { sets: [{ name: 'Broken', sessions: {} }] },
    { workspaces: [{ id: 'ws', name: 'Broken' }] },
    { agents: [null] }, { recentDirs: [false] },
    { migrations: 'already done' }, { windowBounds: { width: 'large' } }
  ])('rejects malformed shapes independently of migrations: %j', (data) => {
    const path = join(dir, 'store.json')
    const first = new Store(path)
    first.saveSessions([session])
    const good = JSON.parse(fs.readFileSync(path, 'utf8'))
    fs.writeFileSync(`${path}.bak`, JSON.stringify(good))
    const raw = data !== null && !Array.isArray(data) && typeof data === 'object'
      ? { ...good, ...data }
      : data
    fs.writeFileSync(path, JSON.stringify(raw))
    const store = new Store(path)
    expect(store.getSessions()).toEqual([session])
  })

  it('preserves legacy missing optional fields and user-selected settings after migrations', () => {
    const path = join(dir, 'store.json')
    const first = new Store(path)
    first.saveSessions([])
    const { migrations } = JSON.parse(fs.readFileSync(path, 'utf8'))
    fs.writeFileSync(path, JSON.stringify({
      migrations, sessions: [session], settings: { contextMode: 'brief', staleHideHours: 12, sound: true }
    }))
    const store = new Store(path)
    expect(store.getSessions()).toEqual([session])
    expect(store.settings).toMatchObject({ contextMode: 'brief', staleHideHours: 12, sound: true, notifications: true })
    expect(store.getSessions()[0].workspaceIds).toBeUndefined()
  })

  it('preserves all last-good copies when backup replacement fails', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    for (const label of ['oldest', 'older', 'latest']) store.saveSessions([{ ...session, label }])
    const paths = [path, `${path}.bak`, `${path}.bak2`]
    const before = paths.map((file) => fs.readFileSync(file, 'utf8'))
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('rotation denied') })
    store.saveSessions([])
    expect(paths.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before)
    expect(fs.readdirSync(dir).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('heals an externally corrupted primary from memory without rotating it over a healthy backup', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    store.saveSessions([session])
    store.saveSessions([session])
    const backup = fs.readFileSync(`${path}.bak`, 'utf8')
    fs.writeFileSync(path, 'external damage')
    store.saveSessions([])
    expect(JSON.parse(fs.readFileSync(path, 'utf8')).sessions).toEqual([])
    expect(fs.readFileSync(`${path}.bak`, 'utf8')).toBe(backup)
  })

  it('reports snapshot read failures instead of silently listing no history', () => {
    const errors = vi.fn()
    const store = new Store(join(dir, 'store.json'), errors)
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => { throw new Error('snapshot access denied') })
    expect(store.listSnapshots()).toEqual([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('snapshot access denied'))
  })

  it('keeps dated history when publication of a new snapshot fails', () => {
    const path = join(dir, 'store.json')
    const store = new Store(path)
    store.saveSessions([session])
    fs.mkdirSync(store.snapshotDir)
    for (let day = 1; day <= 15; day++) {
      fs.writeFileSync(
        join(store.snapshotDir, `crew-store-2026-07-${String(day).padStart(2, '0')}.json`),
        JSON.stringify({ sessions: [session] })
      )
    }
    const before = fs.readdirSync(store.snapshotDir)
    const errors = vi.fn()
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('snapshot sync failed') })
    const reopened = new Store(path, errors)
    expect(reopened.getSessions()).toEqual([session])
    expect(fs.readdirSync(store.snapshotDir)).toEqual(before)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('snapshot sync failed'))
  })

  it('does not treat unreadable backup discovery as a fresh install', () => {
    const path = join(dir, 'store.json')
    const errors = vi.fn()
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('backup directory denied'), { code: 'EACCES' })
    })
    const store = new Store(path, errors)
    store.saveSessions([session])
    expect(fs.existsSync(path)).toBe(false)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('backup directory denied'))
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('saving is disabled'))
  })

  it('never lets a throwing error callback crash a failed save', () => {
    const store = new Store(join(dir, 'store.json'), () => { throw new Error('UI unavailable') })
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('disk failed') })
    expect(() => store.saveSessions([session])).not.toThrow()
    expect(store.getSessions()).toEqual([session])
    expect(console.warn).toHaveBeenCalledWith('[crew] store error callback failed:', expect.any(Error))
  })
})

describe('transcript fault recovery', () => {
  it('keeps pending output after a filesystem failure and retries it', () => {
    const path = join(dir, 'transcripts')
    const errors = vi.fn()
    const recorder = new TranscriptRecorder(path, errors)
    fs.rmdirSync(path)
    fs.writeFileSync(path, 'not a directory')
    recorder.append('one', 'do not lose this\n')
    recorder.flush()
    expect(errors).toHaveBeenCalled()
    fs.unlinkSync(path)
    fs.mkdirSync(path)
    recorder.flush()
    expect(recorder.read('one')).toBe('do not lose this\n')
    recorder.dispose()
  })

  it('does not duplicate bytes after an interrupted partial append', () => {
    const recorder = new TranscriptRecorder(dir)
    vi.mocked(fs.writeSync)
      .mockImplementationOnce((fd: number, buffer: string | NodeJS.ArrayBufferView) => {
        if (!Buffer.isBuffer(buffer)) throw new Error('expected byte-buffer write')
        // Stop inside the four-byte emoji, not at a character boundary.
        return actualFs.writeSync(fd, buffer, 0, 5, null)
      })
      .mockImplementationOnce(() => { throw new Error('interrupted append') })
    recorder.append('one', 'abc🙂def')
    recorder.flush()
    expect(fs.readFileSync(join(dir, 'one.log'))).toEqual(Buffer.from('abc🙂def').subarray(0, 5))
    recorder.append('one', '\nmore 🙂')
    recorder.flush()
    expect(fs.writeSync).toHaveBeenCalled()
    expect(recorder.read('one')).toBe('abc🙂def\nmore 🙂')
    recorder.dispose()
  })

  it('emits backpressure on failure and releases it only after successful flush', () => {
    const path = join(dir, 'transcripts')
    const recorder = new TranscriptRecorder(path)
    const blocked = vi.fn()
    const drained = vi.fn()
    recorder.on('blocked', blocked)
    recorder.on('drained', drained)
    fs.rmdirSync(path)
    fs.writeFileSync(path, 'not a directory')
    recorder.append('one', 'pending')
    recorder.flush()
    expect(blocked).toHaveBeenCalledWith('one')
    expect(drained).not.toHaveBeenCalled()
    fs.unlinkSync(path)
    fs.mkdirSync(path)
    recorder.flush()
    expect(drained).toHaveBeenCalledWith('one')
    recorder.dispose()
  })

  it('retries fsync without reappending bytes, then drains once including newly queued output', () => {
    const errors = vi.fn()
    const recorder = new TranscriptRecorder(dir, errors)
    const blocked = vi.fn()
    const drained = vi.fn()
    recorder.on('blocked', blocked).on('drained', drained)
    vi.mocked(fs.fsyncSync)
      .mockImplementationOnce(() => { throw new Error('sync failed') })
      .mockImplementationOnce(() => { throw new Error('sync still failing') })
    recorder.append('one', '🙂 first')
    recorder.flush()
    expect(fs.readFileSync(join(dir, 'one.log'), 'utf8')).toBe('🙂 first')
    expect(fs.writeSync).toHaveBeenCalledTimes(1)
    recorder.flush()
    expect(fs.writeSync).toHaveBeenCalledTimes(1)
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(drained).not.toHaveBeenCalled()
    recorder.append('one', ' next 🙂')
    recorder.flush()
    expect(fs.writeSync).toHaveBeenCalledTimes(2)
    expect(recorder.read('one')).toBe('🙂 first next 🙂')
    expect(drained).toHaveBeenCalledTimes(1)
    expect(drained).toHaveBeenCalledWith('one')
    expect(vi.getTimerCount()).toBe(0)
    recorder.dispose()
  })

  it('retries zero-byte writes without spinning or discarding data', () => {
    const recorder = new TranscriptRecorder(dir)
    const blocked = vi.fn()
    recorder.on('blocked', blocked)
    vi.mocked(fs.writeSync).mockReturnValueOnce(0)
    recorder.append('one', 'pending')
    recorder.flush()
    expect(blocked).toHaveBeenCalledWith('one')
    recorder.flush()
    expect(recorder.read('one')).toBe('pending')
    recorder.dispose()
  })

  it('immediately flushes at exactly 256 KiB of accumulated UTF-8 bytes', () => {
    const recorder = new TranscriptRecorder(dir)
    const text = '🙂'.repeat((256 * 1024) / 4 - 1)
    recorder.append('one', text)
    expect(fs.existsSync(join(dir, 'one.log'))).toBe(false)
    recorder.append('one', '🙂')
    expect(fs.readFileSync(join(dir, 'one.log'), 'utf8')).toBe(text + '🙂')
    expect(vi.getTimerCount()).toBe(0)
    recorder.dispose()
  })

  it('bounds healthy accumulated bytes across sessions and drops empty queue entries', () => {
    const recorder = new TranscriptRecorder(dir)
    const text = 'x'.repeat(128 * 1024)
    recorder.append('one', text)
    recorder.append('two', text)
    expect(fs.readFileSync(join(dir, 'one.log'), 'utf8')).toBe(text)
    expect(fs.readFileSync(join(dir, 'two.log'), 'utf8')).toBe(text)
    expect(vi.getTimerCount()).toBe(0)
    expect(recorder).toHaveProperty('buffers.size', 0)
    recorder.dispose()
  })

  it('flushes small queues on a timer and stops the timer when drained', () => {
    const recorder = new TranscriptRecorder(dir)
    recorder.append('one', '')
    expect(vi.getTimerCount()).toBe(0)
    recorder.append('one', 'small')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1500)
    expect(fs.readFileSync(join(dir, 'one.log'), 'utf8')).toBe('small')
    expect(vi.getTimerCount()).toBe(0)
    recorder.append('two', 'next')
    expect(vi.getTimerCount()).toBe(1)
    recorder.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains pending bytes after a failed dispose for an explicit retry', () => {
    const recorder = new TranscriptRecorder(dir)
    recorder.append('one', 'last words')
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('shutdown sync failed') })
    recorder.dispose()
    expect(vi.getTimerCount()).toBe(0)
    recorder.flush()
    expect(recorder.read('one')).toBe('last words')
    expect(fs.writeSync).toHaveBeenCalledTimes(1)
  })

  it.each(['../outside', '..\\outside', '/absolute', '.', '..', '', 'a/b', 'a\\b', 'bad\0id'])('rejects unsafe session IDs: %j', (id) => {
    const errors = vi.fn()
    const recorder = new TranscriptRecorder(dir, errors)
    recorder.append(id, 'do not write')
    expect(recorder.read(id)).toBe('')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('invalid transcript session ID'))
    expect(fs.readdirSync(dir)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    recorder.dispose()
  })

  it('reports read/search permission errors but treats ENOENT as empty', () => {
    const errors = vi.fn()
    const recorder = new TranscriptRecorder(dir, errors)
    expect(recorder.read('missing')).toBe('')
    expect(errors).not.toHaveBeenCalled()
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('read denied'), { code: 'EACCES' })
    })
    expect(recorder.read('one')).toBe('')
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('read denied'))
    vi.mocked(fs.readdirSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('search denied'), { code: 'EACCES' })
    })
    expect(recorder.search('query')).toEqual([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('search denied'))
    fs.writeFileSync(join(dir, 'one.log'), 'query')
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw new Error('file denied') })
    expect(recorder.search('query')).toEqual([])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('file denied'))
    recorder.dispose()
  })

  it('preserves read/search results, matching limits and line numbering', () => {
    const recorder = new TranscriptRecorder(dir)
    recorder.append('one', 'first\nMATCH here\n' + 'match\n'.repeat(400))
    expect(recorder.search('  match  ')).toHaveLength(300)
    expect(recorder.search('MATCH here')).toEqual([{ sessionId: 'one', lineNo: 2, line: 'MATCH here' }])
    expect(recorder.read('one')).toMatch(/^first\nMATCH here\n/)
    expect(recorder.search('  ')).toEqual([])
    recorder.dispose()
  })

  it('continues flushing healthy sessions while another is blocked', () => {
    const recorder = new TranscriptRecorder(dir)
    const blocked = vi.fn()
    const drained = vi.fn()
    recorder.on('blocked', blocked).on('drained', drained)
    recorder.append('one', 'retry me')
    recorder.append('two', 'save me')
    vi.mocked(fs.writeSync).mockImplementationOnce(() => { throw new Error('first session failed') })
    recorder.flush()
    expect(blocked).toHaveBeenCalledWith('one')
    expect(fs.readFileSync(join(dir, 'two.log'), 'utf8')).toBe('save me')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1500)
    expect(drained).toHaveBeenCalledWith('one')
    expect(fs.readFileSync(join(dir, 'one.log'), 'utf8')).toBe('retry me')
    expect(vi.getTimerCount()).toBe(0)
    recorder.dispose()
  })
})
