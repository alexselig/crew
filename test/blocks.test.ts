import { describe, it, expect } from 'vitest'
import { BlockTracker } from '../src/shared/blocks'
import { OscParser } from '../src/shared/osc'

const BEL = '\u0007'
const ESC = '\u001b'

/** Drive a tracker from a raw stream via the real OSC parser. */
function run(stream: string, now: () => number = () => 0): BlockTracker {
  const t = new BlockTracker()
  for (const ev of new OscParser().push(stream)) t.apply(ev, now())
  return t
}

describe('BlockTracker', () => {
  it('assembles one completed block from a 133 A/B/C/D cycle', () => {
    const t = run(`${ESC}]133;A${BEL}${ESC}]133;B${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`)
    const blocks = t.list()
    expect(blocks).toHaveLength(1)
    expect(blocks[0].state).toBe('done')
    expect(blocks[0].exitCode).toBe(0)
  })

  it('captures 633 command text and non-zero exit', () => {
    const t = run(`${ESC}]633;A${BEL}${ESC}]633;E;git push${BEL}${ESC}]633;C${BEL}${ESC}]633;D;1${BEL}`)
    const b = t.list()[0]
    expect(b.command).toBe('git push')
    expect(b.exitCode).toBe(1)
    expect(b.state).toBe('done')
  })

  it('records cwd reported mid-block', () => {
    const t = run(`${ESC}]133;A${BEL}${ESC}]7;file://h/tmp${BEL}${ESC}]133;C${BEL}`)
    expect(t.list()[0].cwd).toBe('/tmp')
    expect(t.list()[0].state).toBe('running')
  })

  it('opens a running block when output-start arrives with no prior prompt', () => {
    const t = run(`${ESC}]133;C${BEL}`)
    expect(t.list()).toHaveLength(1)
    expect(t.list()[0].state).toBe('running')
  })

  it('tracks two sequential commands', () => {
    const t = run(
      `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}` +
        `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}`
    )
    expect(t.size).toBe(2)
    expect(t.list().every((b) => b.state === 'done')).toBe(true)
  })

  it('does not create a block for a notification', () => {
    const t = run(`${ESC}]9;hello${BEL}`)
    expect(t.size).toBe(0)
  })

  it('stamps startedAt/endedAt from the clock', () => {
    let clock = 100
    const t = new BlockTracker()
    for (const ev of new OscParser().push(`${ESC}]133;A${BEL}`)) t.apply(ev, clock)
    clock = 250
    for (const ev of new OscParser().push(`${ESC}]133;D;0${BEL}`)) t.apply(ev, clock)
    const b = t.list()[0]
    expect(b.startedAt).toBe(100)
    expect(b.endedAt).toBe(250)
  })

  it('list() returns a copy (callers cannot mutate internal state)', () => {
    const t = run(`${ESC}]133;A${BEL}${ESC}]133;D;0${BEL}`)
    t.list().push({ id: 999, state: 'done', startedAt: 0 })
    expect(t.size).toBe(1)
  })
})
