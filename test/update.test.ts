import { describe, it, expect } from 'vitest'
import { compareVersions, isNewer } from '../src/shared/update'

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.4.4', '0.4.3')).toBe(1)
    expect(compareVersions('0.4.3', '0.4.4')).toBe(-1)
    expect(compareVersions('0.5.0', '0.4.9')).toBe(1)
  })

  it('treats equal versions as 0 and pads missing segments', () => {
    expect(compareVersions('0.4.4', '0.4.4')).toBe(0)
    expect(compareVersions('0.4', '0.4.0')).toBe(0)
    expect(compareVersions('1', '1.0.0')).toBe(0)
  })

  it('ignores a leading v and surrounding whitespace', () => {
    expect(compareVersions('v0.4.4', '0.4.3')).toBe(1)
    expect(compareVersions(' 0.4.4 ', 'v0.4.4')).toBe(0)
  })

  it('treats non-numeric segments as 0 (never ranks garbage as newer)', () => {
    expect(compareVersions('0.4.x', '0.4.0')).toBe(0)
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
  })
})

describe('isNewer', () => {
  it('is true only for a strictly greater version', () => {
    expect(isNewer('0.4.4', '0.4.3')).toBe(true)
    expect(isNewer('0.4.3', '0.4.3')).toBe(false)
    expect(isNewer('0.4.2', '0.4.3')).toBe(false)
    expect(isNewer('v0.5.0', '0.4.9')).toBe(true)
  })
})
