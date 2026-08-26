// The plain-text stand-in shown in grid tiles that have no live emulator.
// Correctness here is what makes it safe to withhold a terminal from a tile:
// the user must still be able to read what their agent is doing.

import { describe, it, expect } from 'vitest'
import { previewLines } from '../src/shared/preview'

const ESC = '\u001b'
const BEL = '\u0007'

describe('terminal preview text', () => {
  it('returns nothing for empty output', () => {
    expect(previewLines('')).toEqual([])
    expect(previewLines('   \n  \n')).toEqual([])
  })

  it('strips CSI colour and cursor sequences', () => {
    const raw = `${ESC}[32mBUILD PASSED${ESC}[0m${ESC}[2K${ESC}[1G`
    expect(previewLines(raw)).toEqual(['BUILD PASSED'])
  })

  it('strips OSC sequences, including shell-integration marks', () => {
    const raw = `${ESC}]133;A${BEL}npm test${ESC}]0;title${ESC}\\`
    expect(previewLines(raw)).toEqual(['npm test'])
  })

  it('collapses a redrawn progress line to its final state', () => {
    // A spinner rewrites one line with \r; it must not read as many lines.
    const raw = 'Installing... 10%\rInstalling... 50%\rInstalling... 100%'
    expect(previewLines(raw)).toEqual(['Installing... 100%'])
  })

  it('keeps only the last N lines, newest last', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const out = previewLines(raw, 3)
    expect(out).toEqual(['line 47', 'line 48', 'line 49'])
  })

  it('drops blank lines so a mostly-empty screen still shows content', () => {
    expect(previewLines('a\n\n\n\nb', 12)).toEqual(['a', 'b'])
  })

  it('does not leak control characters into the preview', () => {
    const raw = `${ESC}[31merr${ESC}[0m\u0000\u0008 done`
    const out = previewLines(raw).join('')
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u001b]/)
    expect(out).toContain('err')
  })
})
