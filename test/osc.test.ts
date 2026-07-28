import { describe, it, expect } from 'vitest'
import { OscParser, type OscEvent } from '../src/shared/osc'

const BEL = '\u0007'
const ESC = '\u001b'

function kinds(events: OscEvent[]): string[] {
  return events.map((e) => e.kind)
}

describe('OscParser — OSC 133 prompt marking', () => {
  it('parses A/B/C/D command lifecycle with exit code', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;A${BEL}$ ${ESC}]133;B${BEL}ls${ESC}]133;C${BEL}out${ESC}]133;D;0${BEL}`)
    expect(kinds(evs)).toEqual(['prompt-start', 'input-start', 'output-start', 'command-end'])
    expect(evs[3].exitCode).toBe(0)
  })

  it('reports a non-zero exit code', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;D;2${BEL}`)
    expect(evs[0].kind).toBe('command-end')
    expect(evs[0].exitCode).toBe(2)
  })

  it('command-end with no code has undefined exitCode', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;D${BEL}`)
    expect(evs[0]).toEqual({ kind: 'command-end', exitCode: undefined })
  })
})

describe('OscParser — split across chunks', () => {
  it('buffers a sequence broken between two pushes', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]133;`)).toEqual([])
    const evs = p.push(`A${BEL}`)
    expect(kinds(evs)).toEqual(['prompt-start'])
  })

  it('handles ST (ESC backslash) terminator', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]133;C${ESC}\\`)
    expect(kinds(evs)).toEqual(['output-start'])
  })

  it('buffers a sequence split mid-terminator (ESC then backslash)', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]133;C${ESC}`)).toEqual([])
    expect(kinds(p.push(`\\`))).toEqual(['output-start'])
  })
})

describe('OscParser — 633 / 9 / 7', () => {
  it('parses VS Code OSC 633 command text (E) and end (D)', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]633;E;git status${BEL}${ESC}]633;D;1${BEL}`)
    expect(evs[0]).toEqual({ kind: 'command-text', data: 'git status' })
    expect(evs[1]).toEqual({ kind: 'command-end', exitCode: 1 })
  })

  it('treats OSC 9 text as a notification but ignores OSC 9;4 progress', () => {
    const p = new OscParser()
    expect(p.push(`${ESC}]9;Build done${BEL}`)).toEqual([{ kind: 'notify', data: 'Build done' }])
    expect(p.push(`${ESC}]9;4;1;50${BEL}`)).toEqual([])
  })

  it('decodes OSC 7 cwd from a file URI', () => {
    const p = new OscParser()
    const evs = p.push(`${ESC}]7;file://host/Users/alex/my%20proj${BEL}`)
    expect(evs[0]).toEqual({ kind: 'cwd', cwd: '/Users/alex/my proj' })
  })
})

describe('OscParser — robustness', () => {
  it('ignores plain text and unrelated CSI escape sequences', () => {
    const p = new OscParser()
    expect(p.push(`hello ${ESC}[31mred${ESC}[0m world`)).toEqual([])
  })

  it('does not grow its buffer unbounded on a lone ESC] with no terminator', () => {
    const p = new OscParser()
    p.push(`${ESC}]` + 'x'.repeat(10000))
    // A subsequent complete sequence still parses (buffer was capped, not corrupted).
    const evs = p.push(`${ESC}]133;A${BEL}`)
    expect(kinds(evs)).toContain('prompt-start')
  })

  it('parses many sequences in one chunk in order', () => {
    const p = new OscParser()
    const evs = p.push(
      `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;0${BEL}` +
        `${ESC}]133;A${BEL}${ESC}]133;C${BEL}${ESC}]133;D;3${BEL}`
    )
    expect(kinds(evs)).toEqual([
      'prompt-start',
      'output-start',
      'command-end',
      'prompt-start',
      'output-start',
      'command-end'
    ])
    expect(evs[5].exitCode).toBe(3)
  })
})
