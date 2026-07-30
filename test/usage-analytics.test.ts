import { describe, it, expect } from 'vitest'
import { buildRange, RANGES, type UsageEvent } from '../src/main/usage-analytics'
import type { UsageSlice } from '../src/shared/usage'

const weekSpec = RANGES.find((r) => r.key === 'week')!
const DAY = 86_400_000

/** Label events by their session id directly (session id === project name here). */
function labelBySession(name: string): UsageSlice {
  return { name, tokens: 0, kind: 'repo' }
}

describe('buildRange — per-project series (seriesByProject)', () => {
  const now = new Date('2026-07-28T12:00:00Z')
  // Two projects, tokens on distinct days within the 7-day window.
  const events: UsageEvent[] = [
    { ms: now.getTime() - 1 * DAY, tokens: 100, aiu: 0, session: 'alpha' },
    { ms: now.getTime() - 1 * DAY, tokens: 40, aiu: 0, session: 'beta' },
    { ms: now.getTime() - 3 * DAY, tokens: 60, aiu: 0, session: 'alpha' }
  ]
  const range = buildRange(weekSpec, events, now, labelBySession)

  it('keeps the global series as the sum across projects (the "All" view)', () => {
    expect(range.totalTokens).toBe(200)
    const seriesTotal = range.series.reduce((a, b) => a + b.tokens, 0)
    expect(seriesTotal).toBe(200)
  })

  it('emits a bucket-aligned series for every surfaced project', () => {
    for (const p of range.projects) {
      expect(range.seriesByProject[p.name]).toBeDefined()
      expect(range.seriesByProject[p.name]).toHaveLength(range.series.length)
      // Labels must line up with the global series so the axis is shared.
      expect(range.seriesByProject[p.name].map((b) => b.label)).toEqual(range.series.map((b) => b.label))
    }
  })

  it('per-project series sums to that project total in `projects`', () => {
    const alphaTotal = range.seriesByProject.alpha.reduce((a, b) => a + b.tokens, 0)
    const betaTotal = range.seriesByProject.beta.reduce((a, b) => a + b.tokens, 0)
    expect(alphaTotal).toBe(160)
    expect(betaTotal).toBe(40)
    expect(range.projects.find((p) => p.name === 'alpha')?.tokens).toBe(160)
    expect(range.projects.find((p) => p.name === 'beta')?.tokens).toBe(40)
  })

  it('summing every project series bucket-by-bucket reproduces the global series', () => {
    const combined = range.series.map((_, i) =>
      range.projects.reduce((a, p) => a + range.seriesByProject[p.name][i].tokens, 0)
    )
    expect(combined).toEqual(range.series.map((b) => b.tokens))
  })

  it('places project tokens in different buckets (alpha spans two days, beta one)', () => {
    const alphaNonZero = range.seriesByProject.alpha.filter((b) => b.tokens > 0).length
    const betaNonZero = range.seriesByProject.beta.filter((b) => b.tokens > 0).length
    expect(alphaNonZero).toBe(2)
    expect(betaNonZero).toBe(1)
  })
})

describe('buildRange — "Other" bucket aggregation', () => {
  const now = new Date('2026-07-28T12:00:00Z')
  // 10 distinct projects (> TOP_SLICES = 8) so the tail folds into "Other".
  const events: UsageEvent[] = Array.from({ length: 10 }, (_, i) => ({
    ms: now.getTime() - 1 * DAY,
    tokens: 100 - i, // descending so ranking is deterministic
    aiu: 0,
    session: `proj${String(i).padStart(2, '0')}`
  }))
  const range = buildRange(weekSpec, events, now, labelBySession)

  it('surfaces an "Other" slice with its own aggregated series', () => {
    const other = range.projects.find((p) => p.name === 'Other')
    expect(other).toBeDefined()
    expect(range.seriesByProject.Other).toBeDefined()
    const otherSeriesTotal = range.seriesByProject.Other.reduce((a, b) => a + b.tokens, 0)
    expect(otherSeriesTotal).toBe(other!.tokens)
  })

  it('every surfaced project (incl. Other) has a matching series', () => {
    for (const p of range.projects) {
      expect(range.seriesByProject[p.name]).toBeDefined()
    }
  })
})
