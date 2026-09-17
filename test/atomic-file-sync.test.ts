import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fsyncSync, fstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { operations } = vi.hoisted(() => ({ operations: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    fsyncSync: vi.fn(fs.fsyncSync),
    renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
      fs.renameSync(from, to)
      operations.push('rename')
    }
  }
})

import { atomicWriteFile } from '../src/main/atomic-file'
import { TranscriptRecorder } from '../src/main/transcripts'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let dir: string

function captureError(fn: () => void): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected operation to throw')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crew-directory-sync-'))
  operations.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(fsyncSync).mockImplementation((fd) => {
    operations.push(fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync')
    actualFs.fsyncSync(fd)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Unix publication durability', () => {
  it('syncs the containing directory after atomic rename', () => {
    atomicWriteFile(join(dir, 'state.json'), '{"saved":true}')
    expect(operations).toEqual(['file-sync', 'rename', 'directory-sync'])
  })

  it('reports a failed directory sync without deleting the published file or leaking its handle', () => {
    const path = join(dir, 'state.json')
    writeFileSync(path, 'old')
    let directoryFd: number | undefined
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      if (fstatSync(fd).isDirectory()) {
        directoryFd = fd
        throw new Error('Fixture directory sync failure')
      }
      actualFs.fsyncSync(fd)
    })
    const error = captureError(() => atomicWriteFile(path, 'complete new contents'))
    expect(error).toMatchObject({
      name: 'AtomicWriteError',
      path,
      published: true,
      cause: expect.any(Error)
    })
    expect(error).toHaveProperty('message', 'Fixture directory sync failure')
    expect(readFileSync(path, 'utf8')).toBe('complete new contents')
    expect(readdirSync(dir)).toEqual(['state.json'])
    expect(directoryFd).toBeTypeOf('number')
    expect(() => fstatSync(directoryFd!)).toThrow()
  })

  it('retains transcript capture on directory-sync failure and retries without duplicating bytes', () => {
    const recorder = new TranscriptRecorder(dir)
    const blocked = vi.fn()
    const drained = vi.fn()
    recorder.on('blocked', blocked)
    recorder.on('drained', drained)
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      if (fstatSync(fd).isDirectory()) throw new Error('Fixture directory sync failure')
      actualFs.fsyncSync(fd)
    })
    try {
      recorder.append('session', 'preserved text\n')
      recorder.flush()
      expect(blocked).toHaveBeenCalledOnce()
      expect(drained).not.toHaveBeenCalled()
      vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync)
      recorder.flush()
      expect(drained).toHaveBeenCalledOnce()
      expect(readFileSync(join(dir, 'session.log'), 'utf8')).toBe('preserved text\n')
    } finally {
      recorder.dispose()
    }
  })
})
