import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { pause, resume } = vi.hoisted(() => ({ pause: vi.fn(), resume: vi.fn() }))
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234, onData: () => {}, onExit: () => {},
    write: () => {}, resize: () => {}, kill: () => {}, pause, resume
  }))
}))

import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'
import { TranscriptRecorder } from '../src/main/transcripts'

let dir: string
let manager: SessionManager
let recorder: TranscriptRecorder

beforeEach(() => {
  vi.useFakeTimers()
  pause.mockReset()
  resume.mockReset()
  dir = mkdtempSync(join(tmpdir(), 'crew-recording-'))
  recorder = new TranscriptRecorder(join(dir, 'transcripts'))
  manager = new SessionManager(new Store(join(dir, 'store.json')), recorder)
})

afterEach(() => {
  manager.disposeAll()
  recorder.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('transcript backpressure integration', () => {
  const blocked = (id: string): void => { recorder.emit('blocked', id) }
  const drained = (id: string): void => { recorder.emit('drained', id) }

  it('pauses the affected PTY until buffered transcripts have been durably flushed', () => {
    const session = manager.create({ presetId: 'shell', command: '/bin/sh', args: [], cwd: dir })
    const output = vi.fn()
    manager.on('output', output)
    blocked(session.id)
    blocked(session.id)
    expect(pause).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, data: expect.stringContaining('paused') }))
    drained(session.id)
    drained(session.id)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('never resumes an already-closed process after storage recovers', () => {
    const session = manager.create({ presetId: 'shell', command: '/bin/sh', args: [], cwd: dir })
    blocked(session.id)
    expect(pause).toHaveBeenCalledTimes(1)
    manager.close(session.id)
    drained(session.id)
    expect(resume).not.toHaveBeenCalled()
  })

  it('detaches recorder listeners on shutdown', () => {
    manager.create({ presetId: 'shell', command: '/bin/sh', args: [], cwd: dir })
    expect(recorder.listenerCount('blocked')).toBe(1)
    manager.disposeAll()
    expect(recorder.listenerCount('blocked')).toBe(0)
    expect(recorder.listenerCount('drained')).toBe(0)
  })
})
