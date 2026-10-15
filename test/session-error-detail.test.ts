import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A pty whose data/exit callbacks are reachable from the test, so a session can
// be made to print something and then die the way a real agent does.
type Fake = {
  emitData: (s: string) => void
  emitExit: (code: number, signal?: number) => void
}
const ptys: Fake[] = []

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let onData: (s: string) => void = () => {}
    let onExit: (e: { exitCode: number; signal?: number }) => void = () => {}
    ptys.push({
      emitData: (s) => onData(s),
      emitExit: (code, signal) => onExit({ exitCode: code, signal })
    })
    return {
      pid: 1234,
      onData: (cb: (s: string) => void) => {
        onData = cb
      },
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        onExit = cb
      },
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
  })
}))

import { SessionManager } from '../src/main/session-manager'
import { Store } from '../src/main/store'

let dir: string
let store: Store
let manager: SessionManager

beforeEach(() => {
  ptys.length = 0
  dir = mkdtempSync(join(tmpdir(), 'crew-errdetail-'))
  store = new Store(join(dir, 'store.json'))
  manager = new SessionManager(store)
})

afterEach(() => {
  manager.disposeAll()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function newSession(label = 'Ship-a-skill'): string {
  return manager.create({
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: dir,
    label
  }).id
}

const infoFor = (id: string) => manager.roster().find((s) => s.id === id)!

describe('error card detail', () => {
  it('carries the agent output that explains a failed exit', () => {
    const id = newSession()
    ptys[0].emitData('Loading model...\r\nError: authentication failed (401)\r\n')
    ptys[0].emitExit(1)

    const info = infoFor(id)
    expect(info.status).toBe('error')
    // The card previously showed only this, which never said why.
    expect(info.errorMessage).toContain('exited with code 1')
    expect(info.errorDetail).toContain('Error: authentication failed (401)')
    expect(info.errorDetail).toContain('Loading model...')
  })

  it('shows nothing extra on a clean exit', () => {
    const id = newSession()
    ptys[0].emitData('done\r\n')
    ptys[0].emitExit(0)

    expect(infoFor(id).status).toBe('exited')
    expect(infoFor(id).errorDetail).toBeUndefined()
  })

  it('keeps only the last lines, and only the final redraw of a spinner line', () => {
    const id = newSession()
    for (let i = 0; i < 200; i++) ptys[0].emitData(`line ${i}\r\n`)
    ptys[0].emitData('working |\rworking /\rworking -\r\n')
    ptys[0].emitExit(1)

    const detail = infoFor(id).errorDetail!
    expect(detail.split('\n').length).toBeLessThanOrEqual(12)
    expect(detail).toContain('line 199')
    expect(detail).not.toContain('line 100')
    // A carriage return redraws in place: only the last frame should survive.
    expect(detail).toContain('working -')
    expect(detail).not.toContain('working |')
  })

  it('reassembles a line split across two chunks', () => {
    const id = newSession()
    ptys[0].emitData('Error: ENOENT, no such ')
    ptys[0].emitData('file or directory\r\n')
    ptys[0].emitExit(1)

    expect(infoFor(id).errorDetail).toContain('Error: ENOENT, no such file or directory')
  })

  it('does not carry a dead run output into the relaunched session', () => {
    const id = newSession()
    ptys[0].emitData('Error: authentication failed (401)\r\n')
    ptys[0].emitExit(1)
    expect(infoFor(id).errorDetail).toBeTruthy()

    manager.restart(id)

    const after = infoFor(id)
    expect(after.errorDetail).toBeUndefined()
    expect(after.errorMessage).toBeUndefined()
  })
})
