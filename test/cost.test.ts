import { describe, it, expect } from 'vitest'
import { CostParser, DEFAULT_COST_REGEX_SRC, creditsToUsd } from '../src/shared/cost'

function make(src: string = DEFAULT_COST_REGEX_SRC): CostParser {
  return new CostParser({ costRegex: new RegExp(src) })
}

describe('CostParser', () => {
  it('starts at $0', () => {
    expect(make().usd).toBe(0)
  })

  it('parses a reported "Total cost: $0.42"', () => {
    const c = make()
    expect(c.push('Total cost: $0.42\n')).toBe(true)
    expect(c.usd).toBeCloseTo(0.42)
  })

  it('parses the multi-line /cost block and ignores the duration line', () => {
    const c = make()
    c.push('Total cost:            $1.2345\nTotal duration (API):  1m 3s\n')
    expect(c.usd).toBeCloseTo(1.2345)
  })

  it('tracks the highest cumulative value and never decreases on redraw', () => {
    const c = make()
    c.push('cost $0.10')
    c.push('cost $0.35')
    expect(c.usd).toBeCloseTo(0.35)
    expect(c.push('cost $0.20')).toBe(false) // a lower redraw must not lower spend
    expect(c.usd).toBeCloseTo(0.35)
  })

  it('ignores dollar amounts with no cost keyword nearby', () => {
    const c = make()
    expect(c.push('run it for $5 please')).toBe(false)
    expect(c.usd).toBe(0)
  })

  it('keeps the value after the cost line scrolls out of the buffer', () => {
    const c = make()
    c.push('Session cost: $0.99\n')
    c.push('x'.repeat(7000)) // pushes the cost line beyond the 6000-char tail
    expect(c.usd).toBeCloseTo(0.99)
  })

  it('does nothing when no cost regex is configured', () => {
    const c = new CostParser({ costRegex: null })
    expect(c.push('Total cost: $1.00')).toBe(false)
    expect(c.usd).toBe(0)
  })
})

describe('creditsToUsd', () => {
  it('converts at the default 100 AIC = $1 rate', () => {
    expect(creditsToUsd(100, 100)).toBeCloseTo(1)
    expect(creditsToUsd(7, 100)).toBeCloseTo(0.07)
    expect(creditsToUsd(250, 100)).toBeCloseTo(2.5)
  })

  it('honours a custom rate', () => {
    expect(creditsToUsd(50, 50)).toBeCloseTo(1)
    expect(creditsToUsd(300, 200)).toBeCloseTo(1.5)
  })

  it('returns 0 for zero, negative, or non-finite input', () => {
    expect(creditsToUsd(0, 100)).toBe(0)
    expect(creditsToUsd(-5, 100)).toBe(0)
    expect(creditsToUsd(NaN, 100)).toBe(0)
  })

  it('returns 0 for a non-positive or non-finite rate (never NaN/Infinity)', () => {
    expect(creditsToUsd(100, 0)).toBe(0)
    expect(creditsToUsd(100, -10)).toBe(0)
    expect(creditsToUsd(100, NaN)).toBe(0)
  })
})
