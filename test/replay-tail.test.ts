import { describe, it, expect } from 'vitest'
import { openEscapeAt, orphanLength } from '../src/shared/replay-tail'

const ESC = '\u001b'
const BEL = '\u0007'

describe('detecting a sequence left open by the replay bound', () => {
  it('says nothing is open for ordinary text', () => {
    expect(openEscapeAt('just some output\n')).toBeNull()
  })

  it('says nothing is open when the last sequence completed', () => {
    expect(openEscapeAt(`${ESC}[38;2;145;152;161mcoloured`)).toBeNull()
  })

  it('spots a CSI cut part-way through its parameters', () => {
    expect(openEscapeAt(`old${ESC}[38;`)).toBe('csi')
  })

  it('spots an OSC cut before its terminator', () => {
    expect(openEscapeAt(`${ESC}]133;A`)).toBe('osc')
  })

  it('treats an OSC closed by BEL or by ST as finished', () => {
    expect(openEscapeAt(`${ESC}]133;A${BEL}`)).toBeNull()
    expect(openEscapeAt(`${ESC}]0;title${ESC}\\`)).toBeNull()
  })

  it('spots a bare ESC at the very end, whose meaning is still unknown', () => {
    expect(openEscapeAt(`text${ESC}`)).toBe('esc')
  })

  it('treats a two-unit escape as whole', () => {
    expect(openEscapeAt(`${ESC}M`)).toBeNull()
  })

  it('ignores a sequence that fell outside the inspection window', () => {
    expect(openEscapeAt(`${ESC}[38;` + 'x'.repeat(5000))).toBeNull()
  })

  it('says nothing is open for an empty discard', () => {
    expect(openEscapeAt('')).toBeNull()
  })
})

describe('measuring the orphaned half left at the head of the tail', () => {
  it('consumes a CSI remainder up to and including its final byte', () => {
    // The artifact seen on screen: ESC[38; was discarded, this survived.
    expect(orphanLength('csi', '2;145;152;161mrest')).toBe(14)
  })

  it('consumes an OSC remainder up to and including BEL', () => {
    expect(orphanLength('osc', `133;A${BEL}rest`)).toBe(6)
  })

  it('consumes an OSC remainder terminated by ST', () => {
    expect(orphanLength('osc', `title${ESC}\\rest`)).toBe(7)
  })

  it('consumes exactly one unit after a bare ESC', () => {
    expect(orphanLength('esc', 'Mrest')).toBe(1)
  })

  it('reports -1 when the terminator is in a later part', () => {
    expect(orphanLength('csi', '2;145;152')).toBe(-1)
    expect(orphanLength('osc', '133;A')).toBe(-1)
  })

  it('reports -1 for an empty part so the next one is consumed', () => {
    expect(orphanLength('csi', '')).toBe(-1)
  })

  it('does not mistake CSI parameter bytes for the final byte', () => {
    // Digits and ';' sort below 0x40 precisely so they cannot end a sequence.
    expect(orphanLength('csi', ';;;;9m')).toBe(6)
  })
})
