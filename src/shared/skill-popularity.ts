// Popularity heat for the Skills picker.
//
// Goal: tell the user, at a glance, which installed skills are widely used by
// people today versus rarely used — on a *relative* scale across whatever they
// have installed.
//
// There is no public per-skill telemetry, so `BASE_POPULARITY` is a curated
// heuristic (0–100) reflecting real-world external adoption. It is informed by:
//   - GitHub stars of the source project (anthropics/skills ~163k, obra/
//     superpowers ~259k, mvanhorn/last30days ~53k, gstack: niche, ponytail/
//     Crew personal: bespoke), verified 2026-07 via the GitHub API;
//   - last30days social/engagement research (Reddit/X/HN/YouTube) on which
//     agent skills people actually recommend and invoke.
// It is intentionally easy to update: edit a token's score below. Unknown
// tokens fall back to `DEFAULT_POPULARITY`.
//
// The *displayed* color is always relative: `popularityScale()` min–max
// normalizes the scores of the currently-installed set into five heat tiers, so
// the hottest installed skill anchors the top of the scale and the coldest the
// bottom.

export interface HeatTier {
  /** 1 (coldest) … 5 (hottest). */
  tier: number
  label: string
  /** Reads hot→cold against Crew's near-black Obsidian background. */
  color: string
}

/** Heat ramp (hottest first), drawn from the shared character palette hues. */
export const HEAT_TIERS: HeatTier[] = [
  { tier: 5, label: 'Very popular', color: '#ff5a5a' },
  { tier: 4, label: 'Popular', color: '#ff9f2e' },
  { tier: 3, label: 'Common', color: '#ffd23c' },
  { tier: 2, label: 'Niche', color: '#34d0c3' },
  { tier: 1, label: 'Rarely used', color: '#4aa8ff' }
]

const TIER_BY_RANK = new Map(HEAT_TIERS.map((t) => [t.tier, t]))

/** Score for a skill with no curated entry — modest, so uncurated/custom skills
 * sit low-middle until someone assigns them a real score. */
export const DEFAULT_POPULARITY = 40

// Curated external-popularity scores, keyed by the normalized invoke token
// (lowercased, `g_` namespace prefix stripped — so `g_review` → `review`).
// Grouped by band for readability; the exact numbers only matter relative to
// each other.
export const BASE_POPULARITY: Record<string, number> = {
  // ── Ubiquitous: the Anthropic official pack + the breakout research skill.
  // These are the most-installed agent skills in the world.
  docx: 98,
  pdf: 97,
  xlsx: 96,
  pptx: 95,
  'skill-creator': 92,
  last30days: 90,
  'web-artifacts-builder': 84,
  'mcp-builder': 84,

  // ── Very popular universal dev workflows (mirrored by obra/superpowers,
  // ~259k★, and echoed constantly in community skill lists).
  'systematic-debugging': 88,
  'test-driven-development': 88,
  brainstorming: 82,
  'requesting-code-review': 80,
  'receiving-code-review': 78,
  'writing-plans': 78,
  'executing-plans': 76,
  review: 82,
  investigate: 80,
  ship: 80,
  cso: 74,
  qa: 74,

  // ── Popular but more specialized.
  health: 68,
  'land-and-deploy': 66,
  'document-release': 64,
  'make-pdf': 66,
  spec: 66,
  'design-review': 68,
  browse: 64,
  scrape: 64,
  benchmark: 60,
  'verification-before-completion': 62,
  'subagent-driven-development': 62,
  'using-git-worktrees': 66,
  'dispatching-parallel-agents': 60,
  'writing-skills': 60,
  diagram: 58,
  excalidraw: 58,
  'canvas-design': 56,
  'webapp-testing': 60,
  'frontend-design': 60,
  'finishing-a-development-branch': 56,

  // ── Cooler: framework-flavored, plumbing, or audience-specific.
  'design-shotgun': 48,
  'design-consultation': 46,
  'design-html': 44,
  'devex-review': 46,
  'document-generate': 48,
  learn: 50,
  retro: 50,
  guard: 44,
  careful: 46,
  freeze: 44,
  unfreeze: 40,
  'context-save': 48,
  'context-restore': 48,
  gstack: 44,
  'gstack-upgrade': 36,
  'office-hours': 44,
  'plan-ceo-review': 46,
  'plan-eng-review': 46,
  'plan-design-review': 44,
  'plan-devex-review': 42,
  'plan-tune': 34,
  'qa-only': 52,
  canary: 46,
  codex: 54,
  autoplan: 42,
  'landing-report': 34,
  skillify: 40,
  'setup-deploy': 34,
  'setup-gbrain': 32,
  'sync-gbrain': 34,
  'setup-browser-cookies': 34,
  'open-gstack-browser': 34,
  'pair-agent': 40,
  'benchmark-models': 34,
  'using-superpowers': 44,

  // ── Niche / audience-specific docs & comms skills from the official pack.
  'brand-guidelines': 40,
  'internal-comms': 38,
  'doc-coauthoring': 44,
  'theme-factory': 36,
  'algorithmic-art': 34,
  'slack-gif-creator': 34,
  'claude-api': 44,

  // ── iOS suite: powerful but only for native-iOS developers.
  'ios-fix': 34,
  'ios-qa': 34,
  'ios-design-review': 32,
  'ios-clean': 28,
  'ios-sync': 28,

  // ── Bespoke / personal: little-to-no external audience.
  'crew-screenshots': 16,
  warp: 24,
  loop: 26,
  moonshot: 30,
  'expense-report': 18,
  'vibehub-deployment': 16,
  ponytail: 20,
  'ponytail-audit': 18,
  'ponytail-debt': 18,
  'ponytail-gain': 18,
  'ponytail-help': 16,
  'ponytail-review': 20,
  'customize-cloud-agent': 22,
  'slide-reuse': 30,
  'pptx-chart-beautifier': 30
}

/** Normalize an invoke token / skill name to its popularity key. */
export function normalizeSkillToken(token: string): string {
  return (token || '').toLowerCase().trim().replace(/^g_/, '')
}

/** Curated (absolute) external popularity for a skill, 0–100. */
export function basePopularity(token: string): number {
  const key = normalizeSkillToken(token)
  return key in BASE_POPULARITY ? BASE_POPULARITY[key] : DEFAULT_POPULARITY
}

export interface SkillHeat {
  /** Curated absolute popularity (0–100). */
  score: number
  /** Position within the installed set, 0 (coldest) … 1 (hottest). */
  norm: number
  /** Heat tier 1 (coldest) … 5 (hottest). */
  tier: number
  color: string
  label: string
}

interface Scorable {
  id: string
  invoke?: string
  name: string
}

function normToTier(norm: number): number {
  if (norm >= 0.8) return 5
  if (norm >= 0.6) return 4
  if (norm >= 0.4) return 3
  if (norm >= 0.2) return 2
  return 1
}

/**
 * Compute a *relative* popularity heat for a set of skills. Scores are min–max
 * normalized across the set, so the most-popular installed skill lands in the
 * hottest tier and the least-popular in the coldest. When every skill shares a
 * score (or there's only one), they all land in the middle tier.
 */
export function popularityScale(skills: Scorable[]): Map<string, SkillHeat> {
  const out = new Map<string, SkillHeat>()
  if (skills.length === 0) return out

  const scored = skills.map((s) => ({ id: s.id, score: basePopularity(s.invoke || s.name) }))
  let min = Infinity
  let max = -Infinity
  for (const { score } of scored) {
    if (score < min) min = score
    if (score > max) max = score
  }
  const span = max - min

  for (const { id, score } of scored) {
    const norm = span === 0 ? 0.5 : (score - min) / span
    const tier = normToTier(norm)
    const t = TIER_BY_RANK.get(tier)!
    out.set(id, { score, norm, tier, color: t.color, label: t.label })
  }
  return out
}
