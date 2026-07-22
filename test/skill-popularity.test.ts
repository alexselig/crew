import { describe, it, expect } from 'vitest'
import {
  basePopularity,
  normalizeSkillToken,
  popularityScale,
  BASE_POPULARITY,
  DEFAULT_POPULARITY,
  HEAT_TIERS
} from '../src/shared/skill-popularity'

function skill(id: string, invoke = id) {
  return { id, invoke, name: id }
}

describe('normalizeSkillToken', () => {
  it('lowercases and strips the gstack g_ prefix', () => {
    expect(normalizeSkillToken('g_review')).toBe('review')
    expect(normalizeSkillToken('Design-Review')).toBe('design-review')
    expect(normalizeSkillToken('  Ship ')).toBe('ship')
  })
})

describe('basePopularity', () => {
  it('resolves curated scores through the g_ namespace', () => {
    expect(basePopularity('docx')).toBe(BASE_POPULARITY.docx)
    expect(basePopularity('g_review')).toBe(BASE_POPULARITY.review)
  })

  it('falls back to the default for unknown skills', () => {
    expect(basePopularity('totally-made-up-skill')).toBe(DEFAULT_POPULARITY)
  })
})

describe('popularityScale (relative)', () => {
  it('puts the most-popular installed skill in the hottest tier and the least in the coldest', () => {
    const scale = popularityScale([skill('docx'), skill('crew-screenshots'), skill('diagram')])
    expect(scale.get('docx')!.tier).toBe(5)
    expect(scale.get('crew-screenshots')!.tier).toBe(1)
    // A mid-scored skill sits strictly between the extremes.
    const mid = scale.get('diagram')!.tier
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(5)
  })

  it('is monotonic: higher base score never yields a lower tier', () => {
    const ids = Object.keys(BASE_POPULARITY)
    const scale = popularityScale(ids.map((id) => skill(id)))
    const rows = ids
      .map((id) => ({ score: BASE_POPULARITY[id], tier: scale.get(id)!.tier }))
      .sort((a, b) => a.score - b.score)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].tier).toBeGreaterThanOrEqual(rows[i - 1].tier)
    }
  })

  it('spans the full 1..5 range across a diverse installed set', () => {
    const scale = popularityScale(Object.keys(BASE_POPULARITY).map((id) => skill(id)))
    const tiers = new Set([...scale.values()].map((h) => h.tier))
    for (const t of [1, 2, 3, 4, 5]) expect(tiers.has(t)).toBe(true)
  })

  it('assigns the middle tier when every skill shares a score', () => {
    const scale = popularityScale([skill('a'), skill('b'), skill('c')]) // all unknown → default
    for (const h of scale.values()) {
      expect(h.norm).toBe(0.5)
      expect(h.tier).toBe(3)
    }
  })

  it('normalizes using invoke token, not the display name', () => {
    // name is g_-free display, invoke keeps the on-disk token.
    const scale = popularityScale([
      { id: 'copilot:g_review', name: 'review', invoke: 'g_review' },
      { id: 'copilot:crew-screenshots', name: 'crew-screenshots', invoke: 'crew-screenshots' }
    ])
    expect(scale.get('copilot:g_review')!.score).toBe(BASE_POPULARITY.review)
    expect(scale.get('copilot:g_review')!.tier).toBe(5)
  })

  it('returns an empty map for no skills', () => {
    expect(popularityScale([]).size).toBe(0)
  })

  it('exposes a color for every tier via HEAT_TIERS', () => {
    const scale = popularityScale([skill('docx'), skill('crew-screenshots')])
    for (const h of scale.values()) {
      const tier = HEAT_TIERS.find((t) => t.tier === h.tier)!
      expect(h.color).toBe(tier.color)
      expect(h.label).toBe(tier.label)
    }
  })
})
