import { describe, it, expect } from 'vitest'
import { OscParser } from '../src/shared/osc'

const ESC = '\u001b'
const BEL = '\u0007'

// Guard rails, not micro-benchmarks: bounds are ~100x the observed times
// (plain text ~11ms/80MB, heavy OSC ~13ms/2MB, unterminated ~6ms) so they never
// flake on a loaded CI box, yet still catch a pathological regression such as a
// ReDoS in the OSC regex or the streaming buffer growing without bound.

describe('OscParser — performance / DoS resistance', () => {
  it('streams plain text with negligible overhead', () => {
    const p = new OscParser()
    const chunk = 'x'.repeat(4096) + '\n'
    const t = performance.now()
    for (let i = 0; i < 5000; i++) p.push(chunk)
    expect(performance.now() - t).toBeLessThan(1500)
  })

  it('parses a heavy OSC 133 shell-integration stream quickly', () => {
    const p = new OscParser()
    const chunk = `${ESC}]133;A${BEL}$ ls${ESC}]133;C${BEL}file1 file2\n${ESC}]133;D;0${BEL}`
    const t = performance.now()
    let events = 0
    for (let i = 0; i < 20000; i++) events += p.push(chunk).length
    expect(events).toBe(60000)
    expect(performance.now() - t).toBeLessThan(1500)
  })

  it('stays bounded on a flood of unterminated ESC] (no ReDoS, no memory blowup)', () => {
    const p = new OscParser()
    const t = performance.now()
    for (let i = 0; i < 5000; i++) p.push(`${ESC}]` + 'A'.repeat(1000))
    // A real sequence still parses afterwards → internal buffer wasn't corrupted.
    expect(p.push(`${ESC}]133;A${BEL}`).map((e) => e.kind)).toEqual(['prompt-start'])
    expect(performance.now() - t).toBeLessThan(1500)
  })
})
