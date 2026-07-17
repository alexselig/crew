// Catalog of skills the user can invoke in an agent session. Clicking a chip
// previews the description; a second click types `use <invoke> to ` into the
// session's input so the user can append their goal and hit Enter.
//
// The live list comes from the skills installed on disk for the session's agent
// (see main/skills.ts); the static set below is a fallback for environments
// where none are discovered.

import type { InstalledSkill } from '../shared/api'
import { groupColor } from '../shared/palette'


export interface Skill {
  id: string
  /** Chip label. */
  name: string
  /** Token used in `use <invoke> to …`. */
  invoke: string
  description: string
  category?: 'Build & ship' | 'Quality' | 'Design' | 'Docs & content' | 'Ops' | 'Custom'
  /** True for user-added skills (removable). */
  custom?: boolean
}

export const SKILLS: Skill[] = [
  // Build & ship
  { id: 'ship', name: 'Ship', invoke: 'ship', category: 'Build & ship', description: 'Run the ship workflow: tests, changelog, version bump, commit, push, and open a PR.' },
  { id: 'land', name: 'Land & deploy', invoke: 'land-and-deploy', category: 'Build & ship', description: 'Merge the PR, wait for CI and deploy, then verify production health.' },
  { id: 'investigate', name: 'Investigate', invoke: 'investigate', category: 'Build & ship', description: 'Systematically debug an issue to its root cause before proposing a fix.' },
  { id: 'checkpoint', name: 'Checkpoint', invoke: 'checkpoint', category: 'Build & ship', description: 'Save the current working state and decisions so you can resume later.' },

  // Quality
  { id: 'codex', name: 'Codex review', invoke: 'codex', category: 'Quality', description: 'Get an independent, adversarial code review / second opinion from Codex.' },
  { id: 'health', name: 'Health', invoke: 'health', category: 'Quality', description: 'Compute a weighted code-quality score (types, lint, tests, dead code) and track trends.' },
  { id: 'cso', name: 'Security audit', invoke: 'cso', category: 'Quality', description: 'Run a Chief Security Officer audit: secrets, deps, OWASP, threat modeling.' },
  { id: 'benchmark', name: 'Benchmark', invoke: 'benchmark', category: 'Quality', description: 'Detect performance regressions vs a baseline (load times, web vitals, bundle size).' },

  // Design
  { id: 'design-review', name: 'Design review', invoke: 'design-review', category: 'Design', description: "A designer's-eye QA pass that finds and fixes visual inconsistency and slop." },
  { id: 'design-shotgun', name: 'Design shotgun', invoke: 'design-shotgun', category: 'Design', description: 'Generate multiple design variants and compare them on a board.' },
  { id: 'browse', name: 'Browse', invoke: 'browse', category: 'Design', description: 'Drive a headless browser to QA a page, take screenshots, or dogfood a flow.' },

  // Docs & content
  { id: 'pptx', name: 'PowerPoint', invoke: 'pptx', category: 'Docs & content', description: 'Create or edit a PowerPoint (.pptx) deck.' },
  { id: 'docx', name: 'Word', invoke: 'docx', category: 'Docs & content', description: 'Create or edit a Word (.docx) document.' },
  { id: 'xlsx', name: 'Excel', invoke: 'xlsx', category: 'Docs & content', description: 'Create or edit an Excel (.xlsx) spreadsheet.' },
  { id: 'pdf', name: 'PDF', invoke: 'pdf', category: 'Docs & content', description: 'Create, edit, fill, or extract content from a PDF.' },
  { id: 'document-release', name: 'Doc release', invoke: 'document-release', category: 'Docs & content', description: 'Update README / docs / CHANGELOG to match what actually shipped.' },

  // Ops
  { id: 'canary', name: 'Canary', invoke: 'canary', category: 'Ops', description: 'Watch a live deploy for console errors, perf regressions, and page failures.' },
  { id: 'learn', name: 'Learnings', invoke: 'learn', category: 'Ops', description: 'Review, search, or prune what the agent has learned across sessions.' },
  { id: 'retro', name: 'Retro', invoke: 'retro', category: 'Ops', description: 'Run a retrospective on the work and capture takeaways.' }
]

// ---- User customization (favorites + custom skills), persisted to localStorage ----

const FAV_KEY = 'crew.skills.favorites'
const CUSTOM_KEY = 'crew.skills.custom'

export function loadFavorites(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveFavorites(ids: string[]): void {
  localStorage.setItem(FAV_KEY, JSON.stringify(ids))
}

export function loadCustomSkills(): Skill[] {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]') as Skill[]
    return list.map((s) => ({ ...s, custom: true, category: 'Custom' }))
  } catch {
    return []
  }
}

export function saveCustomSkills(list: Skill[]): void {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list))
}

/** Map a disk-discovered skill into a picker Skill. The display name drops the
 * gstack `g_` namespace prefix for readability, but the invoke token keeps the
 * skill's exact on-disk name so `use <invoke> to …` resolves correctly. */
export function installedToSkill(s: InstalledSkill): Skill {
  return {
    id: s.id,
    name: s.name.replace(/^g_/, ''),
    invoke: s.name,
    description: s.description || `Run the ${s.name} skill.`
  }
}

// ---- Category taxonomy (for the grouped picker) ----
// Derived from skill naming conventions (ios-*, design-*, document-*, …); any
// skill that doesn't fit a bucket lands in "Other". User-added skills group
// under "Custom". Order here is the display order in the picker.

export type SkillCategory =
  | 'Design'
  | 'iOS'
  | 'Release'
  | 'Docs'
  | 'Ops & Safety'
  | 'Context'
  | 'Other'
  | 'Custom'

export const SKILL_CATEGORY_ORDER: SkillCategory[] = [
  'Design',
  'iOS',
  'Release',
  'Docs',
  'Ops & Safety',
  'Context',
  'Other',
  'Custom'
]

/** Bucket a skill by its invoke token (falling back to name). */
export function categoryOf(skill: Skill): SkillCategory {
  if (skill.custom) return 'Custom'
  // Strip the gstack `g_` namespace prefix so `g_design-review` buckets like
  // `design-review`.
  const t = (skill.invoke || skill.name).toLowerCase().replace(/^g_/, '')
  if (t === 'ios-design-review' || t.startsWith('design') || t === 'diagram') return 'Design'
  if (t.startsWith('ios')) return 'iOS'
  if (t === 'document-release' || t.startsWith('land') || t.startsWith('gstack') || t === 'ship')
    return 'Release'
  if (t.startsWith('document') || t === 'make-pdf' || t === 'learn' || ['pdf', 'pptx', 'docx', 'xlsx'].includes(t))
    return 'Docs'
  if (['guard', 'health', 'investigate', 'freeze', 'careful', 'canary'].includes(t)) return 'Ops & Safety'
  if (t.startsWith('context') || t === 'crew-screenshots' || t === 'cso') return 'Context'
  return 'Other'
}

/** A stable swatch color for a category — hashed onto the shared palette (like
 * nav group colors) so it stays consistent with the rest of the app. */
export function categoryColor(category: SkillCategory): string {
  return groupColor(category)
}
