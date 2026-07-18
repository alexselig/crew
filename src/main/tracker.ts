// tracker.ts — derives the live Project Tracker data model from disk for the
// working directories of the currently open sessions. Everything is read fresh
// on each scan (git, package.json, task files), so the tracker reflects reality
// each time it opens. All git/fs work is async (execFile + fs/promises) so it
// never blocks the main thread / live PTYs.
//
// Ported from ~/project-tracker/lib/scan.mjs, scoped to open sessions only.

import { execFile } from 'node:child_process'
import { readFile, readdir, access } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import type {
  ProjectOrigin,
  ProjectStatus,
  TrackerChangelog,
  TrackerCommit,
  TrackerData,
  TrackerGroup,
  TrackerNextStep,
  TrackerProject,
  TrackerSessionInput,
  CommitActivity
} from '../shared/tracker'

const HOME = homedir()

// Group presentation, mirroring the standalone tracker's config. Known tags get
// a canonical label + editorial blurb; unknown tags fall back to the raw tag.
const TAG_META: Record<string, { label: string; blurb: string }> = {
  work: { label: 'Work', blurb: 'Shipping for the PowerPoint Copilot motion' },
  tools: { label: 'Tools', blurb: 'Internal tools & creator utilities' },
  crew: { label: 'Crew', blurb: 'The agent mission-control app & its assets' },
  game: { label: 'Games', blurb: 'Side games & interactive experiments' },
  games: { label: 'Games', blurb: 'Side games & interactive experiments' },
  other: { label: 'Other', blurb: 'Personal projects & everything else' }
}
const TAG_ORDER = ['work', 'tools', 'crew', 'game', 'games', 'other']

// ── async helpers ────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 5000, killSignal: 'SIGKILL' },
      (err, stdout) => resolve(err ? '' : String(stdout).trim())
    )
  })
}

async function readJSON<T = Record<string, unknown>>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T
  } catch {
    return null
  }
}

async function readText(p: string): Promise<string> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return ''
  }
}

async function listDir(p: string): Promise<string[]> {
  try {
    return await readdir(p)
  } catch {
    return []
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Case-insensitive lookup of a file among a directory's entries. */
function findFile(entries: string[], dir: string, names: string[]): string | null {
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]))
  for (const n of names) {
    const hit = lower.get(n.toLowerCase())
    if (hit) return join(dir, hit)
  }
  return null
}

function relTime(ms: number): string | null {
  if (!ms) return null
  const d = Math.floor((Date.now() - ms) / 1000)
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  const days = Math.floor(d / 86400)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// ── per-project derivation ─────────────────────────────────────────────────

function githubUrlFrom(raw: string): string | null {
  if (!raw) return null
  let u = raw.trim()
  if (u.startsWith('git@')) u = u.replace(':', '/').replace('git@', 'https://')
  u = u.replace(/\.git$/, '')
  return u.startsWith('http') ? u : null
}

function originOf(github: string | null): ProjectOrigin | null {
  if (!github) return null
  if (/github\.com\/alexselig[-_]microsoft\//i.test(github)) return 'work'
  if (/github\.com\/alexselig\//i.test(github)) return 'personal'
  return 'external'
}

const BUMP_RE = /(bump|release|v?\d+\.\d+\.\d+|changelog)/i

// ── commit cache ─────────────────────────────────────────────────────────────
// `git log` is the most repeated cost (tracker scan + Activity feed re-open on
// it constantly). Cache parsed commits per repo, keyed by cwd. Within FRESH_MS
// we reuse blindly; beyond that we run one cheap `git rev-parse HEAD` and reuse
// the cached log unless HEAD moved (a new commit landed). Only absolute
// timestamps are cached — relative "when" is recomputed on read so it never
// goes stale. In-memory: the concern is repeat views within a session.

interface RawCommit {
  sha: string
  subject: string
  ts: number
  isRelease: boolean
}

interface CommitCacheEntry {
  head: string
  at: number
  commits: RawCommit[]
}

const COMMIT_CACHE_N = 12
const FRESH_MS = 15_000
const commitCache = new Map<string, CommitCacheEntry>()

async function fetchRawCommits(cwd: string): Promise<RawCommit[]> {
  const cached = commitCache.get(cwd)
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.commits

  const head = await git(['rev-parse', 'HEAD'], cwd)
  if (cached && head && cached.head === head) {
    cached.at = Date.now()
    return cached.commits
  }

  const raw = await git(['log', `-n${COMMIT_CACHE_N}`, '--no-merges', '--pretty=format:%H\u001f%s\u001f%cI'], cwd)
  const commits: RawCommit[] = raw
    ? raw.split('\n').map((line) => {
        const [sha, subject, iso] = line.split('\u001f')
        return {
          sha: (sha || '').slice(0, 7),
          subject: subject || '',
          ts: iso ? Date.parse(iso) : 0,
          isRelease: BUMP_RE.test(subject || '')
        }
      })
    : []
  commitCache.set(cwd, { head, at: Date.now(), commits })
  return commits
}

async function getCommits(cwd: string): Promise<TrackerCommit[]> {
  const raw = await fetchRawCommits(cwd)
  return raw.map((c) => ({ sha: c.sha, subject: c.subject, when: relTime(c.ts), isRelease: c.isRelease }))
}

async function getChangelog(entries: string[], cwd: string): Promise<TrackerChangelog[]> {
  const p = findFile(entries, cwd, ['CHANGELOG.md', 'CHANGELOG', 'changelog.md'])
  if (!p) return []
  const text = await readText(p)
  if (!text) return []
  const sections: TrackerChangelog[] = []
  let cur: TrackerChangelog | null = null
  const head = /^#{1,3}\s*\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/i
  for (const line of text.split('\n')) {
    const m = line.match(head)
    if (m) {
      if (cur) sections.push(cur)
      cur = { version: `v${m[1]}`, items: [] }
      continue
    }
    if (cur) {
      const im = line.match(/^\s*[-*]\s+(.*\S)/)
      if (im && cur.items.length < 8) cur.items.push(im[1].replace(/\*\*/g, ''))
    }
  }
  if (cur) sections.push(cur)
  return sections.slice(0, 6)
}

const TASK_FILES = ['TODO.md', 'TODO', 'STATUS.md', '.crew-progress.md', 'ROADMAP.md', 'NEXT.md', 'TASKS.md', 'PLAN.md']
const SECTION_RE = /^#{1,6}\s*(next steps?|to ?do|todo|roadmap|remaining|up next|what'?s next|open (tasks|items)|backlog)\b/i

async function getNextSteps(entries: string[], cwd: string): Promise<TrackerNextStep[]> {
  const steps: TrackerNextStep[] = []
  const pushItem = (text: string, source: string): void => {
    const t = text.trim().replace(/\*\*/g, '').replace(/`/g, '')
    if (/^(✅|✔️?|✓|☑️?|~~|\[x\])/i.test(t)) return
    if (t && t.length > 2 && steps.length < 8 && !steps.some((s) => s.text === t)) {
      steps.push({ text: t, source })
    }
  }

  // 1) explicit task files: unchecked checkboxes anywhere in the file.
  for (const fname of TASK_FILES) {
    const p = findFile(entries, cwd, [fname])
    if (!p) continue
    const src = basename(p)
    for (const line of (await readText(p)).split('\n')) {
      const m = line.match(/^\s*[-*]\s*\[ \]\s+(.*\S)/)
      if (m) pushItem(m[1], src)
      if (steps.length >= 8) break
    }
    if (steps.length >= 8) break
  }

  // 2) bullets under a "Next steps"/"TODO"/"Roadmap" heading in any root markdown.
  if (steps.length < 8) {
    const mds = entries.filter((f) => /\.md$/i.test(f)).slice(0, 12)
    for (const f of mds) {
      const lines = (await readText(join(cwd, f))).split('\n')
      let inSec = false
      for (const line of lines) {
        if (/^#{1,6}\s/.test(line)) inSec = SECTION_RE.test(line)
        else if (inSec) {
          const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*\S)/)
          if (m && !/^\[x\]/i.test(m[1])) pushItem(m[1].replace(/^\[ \]\s*/, ''), f)
        }
        if (steps.length >= 8) break
      }
      if (steps.length >= 8) break
    }
  }
  return steps
}

interface Stats {
  commitCount: number
  lastCommitIso: string | null
  lastCommitWhen: string | null
  daysSinceCommit: number | null
  uncommitted: number
  ahead: number
  isGit: boolean
  hasTag: boolean
  hasReadme: boolean
  hasChangelog: boolean
  hasLicense: boolean
  hasTests: boolean
  isNode: boolean
  specOnly: boolean
}

async function projectStats(
  entries: string[],
  cwd: string,
  pkg: Record<string, unknown> | null
): Promise<Stats> {
  const isGit = await exists(join(cwd, '.git'))
  const [lastCommitIso, commitCountRaw, porcelain, aheadRaw, tag] = isGit
    ? await Promise.all([
        git(['log', '-1', '--pretty=format:%cI'], cwd),
        git(['rev-list', '--count', 'HEAD'], cwd),
        git(['status', '--porcelain'], cwd),
        git(['rev-list', '--count', '@{u}..HEAD'], cwd),
        git(['describe', '--tags', '--abbrev=0'], cwd)
      ])
    : ['', '', '', '', '']

  const scripts = (pkg?.scripts as Record<string, string>) || {}
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>
  const hasTests =
    !!(scripts.test && !/no test specified/i.test(scripts.test)) ||
    entries.includes('test') ||
    entries.includes('tests') ||
    entries.includes('__tests__') ||
    !!deps.vitest ||
    !!deps.jest ||
    !!deps.mocha ||
    !!deps.playwright
  const isNode = !!pkg
  const htmlFiles = entries.filter((e) => /\.html$/i.test(e))
  const CODE_DIRS = ['src', 'app', 'lib', 'pages', 'components', 'analysis', 'scripts', 'scenes', 'src-tauri', 'cmd', 'internal']
  const CODE_FILE = /\.(py|gd|js|mjs|cjs|ts|tsx|jsx|go|rs|java|cs|cpp|cc|c|swift|sh|rb|php|vue|svelte)$/i
  const GAME_ENGINE = entries.some((e) => e === 'project.godot' || /\.(uproject|unity|sln|xcodeproj)$/i.test(e))
  const hasCodeDir = entries.some((e) => CODE_DIRS.includes(e.toLowerCase()))
  const hasCodeFile = entries.some((e) => CODE_FILE.test(e))
  const codeish = isNode || htmlFiles.length > 0 || hasCodeDir || hasCodeFile || GAME_ENGINE
  const mdCount = entries.filter((e) => /\.md$/i.test(e)).length
  const commitCount = Number(commitCountRaw) || 0
  const lastMs = lastCommitIso ? Date.parse(lastCommitIso) : 0

  return {
    commitCount,
    lastCommitIso: lastCommitIso || null,
    lastCommitWhen: relTime(lastMs),
    daysSinceCommit: lastCommitIso ? Math.floor((Date.now() - lastMs) / 86400000) : null,
    uncommitted: porcelain ? porcelain.split('\n').filter(Boolean).length : 0,
    ahead: Number(aheadRaw) || 0,
    isGit,
    hasTag: !!tag,
    hasReadme: !!findFile(entries, cwd, ['README.md', 'README', 'readme.md']),
    hasChangelog: !!findFile(entries, cwd, ['CHANGELOG.md', 'CHANGELOG']),
    hasLicense: !!findFile(entries, cwd, ['LICENSE', 'LICENSE.md', 'LICENSE.txt']),
    hasTests,
    isNode,
    specOnly: !codeish && mdCount > 0
  }
}

function detectFramework(pkg: Record<string, unknown> | null, entries: string[]): string | null {
  const scripts = (pkg?.scripts as Record<string, string>) || {}
  const deps = { ...(pkg?.dependencies as object), ...(pkg?.devDependencies as object) } as Record<string, string>
  if (deps.next) return 'next'
  if (deps.vite || scripts.dev === 'vite') return 'vite'
  if (deps.electron || /electron/.test(scripts.dev || '')) return 'electron'
  if (scripts.dev || scripts.start) return 'node'
  if (entries.some((e) => /\.html$/i.test(e))) return 'static'
  return null
}

function getSuggestions(stats: Stats, project: TrackerProject): string[] {
  const s: { priority: number; text: string }[] = []
  const add = (priority: number, text: string): void => {
    s.push({ priority, text })
  }
  const fw = project.framework
  const deployable = fw != null && fw !== 'electron'

  if (stats.uncommitted > 0) add(1, `Commit or stash ${stats.uncommitted} uncommitted change${stats.uncommitted > 1 ? 's' : ''}`)
  if (!stats.isGit && !stats.specOnly) add(1, 'Put it under version control — git init & push to GitHub')
  if (stats.ahead > 0) add(2, `Push ${stats.ahead} unpushed commit${stats.ahead > 1 ? 's' : ''} to GitHub`)
  if (stats.specOnly) add(2, 'Start implementation — this is spec/plan-only so far')
  if (!project.github && stats.isGit && !stats.specOnly) add(3, 'Add a GitHub remote so the code is backed up')
  if (!stats.hasTests && stats.isNode) add(4, 'Add automated tests (no test setup detected)')
  if (!project.live && deployable && stats.isGit) add(4, 'Deploy it so you have a shareable live link')
  if (!project.live && fw === 'static' && stats.isGit) add(4, 'Publish via GitHub Pages for a live link')
  if (!stats.hasReadme && !stats.specOnly) add(5, 'Write a README describing what it does & how to run it')
  if (stats.isNode && stats.isGit && !stats.hasTag && stats.commitCount > 8) add(6, 'Tag a release (git tag) to snapshot this version')
  if (!stats.hasChangelog && stats.commitCount > 15 && stats.isNode) add(6, 'Start a CHANGELOG to track what ships each release')
  if (stats.daysSinceCommit != null && stats.daysSinceCommit > 14) add(7, `Revisit — no commits in ${stats.daysSinceCommit} days`)
  if (stats.isNode && !stats.hasLicense && project.github && /github\.com\/[^/]+\/[^/]+$/.test(project.github)) add(8, 'Add a LICENSE file')

  return s
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5)
    .map((x) => x.text)
}

function displayDir(cwd: string): string {
  return cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd
}

async function deriveProject(input: TrackerSessionInput): Promise<TrackerProject> {
  const cwd = input.cwd
  const entries = await listDir(cwd)
  const pkg = await readJSON(join(cwd, 'package.json'))

  const [stats, commits, changelog, nextSteps, remoteRaw, branch, tag] = await Promise.all([
    projectStats(entries, cwd, pkg),
    getCommits(cwd),
    getChangelog(entries, cwd),
    getNextSteps(entries, cwd),
    git(['remote', 'get-url', 'origin'], cwd),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['describe', '--tags', '--abbrev=0'], cwd)
  ])

  const github = githubUrlFrom(remoteRaw)
  const pkgVersion = pkg?.version ? `v${pkg.version as string}` : null
  const version =
    pkgVersion ||
    (tag ? (tag.startsWith('v') ? tag : `v${tag}`) : null) ||
    (stats.commitCount ? `${stats.commitCount} commits` : '—')
  const framework = detectFramework(pkg, entries)

  let status: ProjectStatus
  if (stats.specOnly) status = 'spec'
  else if (stats.daysSinceCommit == null) status = 'unknown'
  else if (stats.daysSinceCommit <= 7) status = 'active'
  else if (stats.daysSinceCommit <= 30) status = 'recent'
  else status = 'stale'

  const pkgHome = typeof pkg?.homepage === 'string' ? (pkg.homepage as string) : null
  const live = pkgHome && /^https?:\/\//.test(pkgHome) ? pkgHome : /\.github\.io$/i.test(basename(cwd)) ? `https://${basename(cwd)}/` : null

  const project: TrackerProject = {
    cwd,
    dir: displayDir(cwd),
    name: basename(cwd) || cwd,
    tag: input.tag,
    color: input.color,
    origin: originOf(github),
    github,
    live,
    version,
    framework,
    branch: branch || null,
    status,
    commitCount: stats.commitCount,
    lastCommitWhen: stats.lastCommitWhen,
    uncommitted: stats.uncommitted,
    ahead: stats.ahead,
    lastActive: input.lastActive,
    lastActiveWhen: relTime(input.lastActive),
    openSessions: input.sessions.length,
    sessions: input.sessions,
    nextSteps,
    suggestions: [],
    commits,
    changelog
  }
  project.suggestions = getSuggestions(stats, project)
  return project
}

const canonicalTag = (tag: string): string => {
  const key = tag.trim().toLowerCase()
  const idx = TAG_ORDER.indexOf(key)
  return idx >= 0 ? key : tag.trim()
}

/**
 * Scan the given open-session projects (one per cwd) and assemble the grouped,
 * ordered Project Tracker data model.
 */
export async function scanProjects(inputs: TrackerSessionInput[]): Promise<TrackerData> {
  const projects = await Promise.all(inputs.map(deriveProject))

  // Group by canonical tag; known tags in TAG_ORDER first, then the rest A→Z.
  const byTag = new Map<string, TrackerProject[]>()
  for (const p of projects) {
    const key = canonicalTag(p.tag)
    const arr = byTag.get(key)
    if (arr) arr.push(p)
    else byTag.set(key, [p])
  }
  const keys = [...byTag.keys()].sort((a, b) => {
    const ia = TAG_ORDER.indexOf(a.toLowerCase())
    const ib = TAG_ORDER.indexOf(b.toLowerCase())
    if (ia >= 0 && ib >= 0) return ia - ib
    if (ia >= 0) return -1
    if (ib >= 0) return 1
    return a.localeCompare(b)
  })

  const groups: TrackerGroup[] = keys.map((key) => {
    const meta = TAG_META[key.toLowerCase()]
    return {
      tag: key,
      label: meta?.label || (key ? key[0].toUpperCase() + key.slice(1) : key),
      blurb: meta?.blurb || '',
      // Projects with open work first, then most-recently-active.
      projects: byTag.get(key)!.sort(
        (a, b) => Number(b.nextSteps.length > 0) - Number(a.nextSteps.length > 0) || b.lastActive - a.lastActive
      )
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      projects: projects.length,
      groups: groups.length,
      openTasks: projects.reduce((n, p) => n + p.nextSteps.length, 0),
      repos: projects.filter((p) => p.commitCount > 0 || p.branch).length,
      sessions: projects.reduce((n, p) => n + p.openSessions, 0)
    },
    groups
  }
}

/**
 * Recent git commits across the given projects, merged and sorted newest-first,
 * each with an absolute timestamp. Feeds the Activity tab of the analytics modal.
 */
export async function recentCommits(
  projects: { cwd: string; name: string }[]
): Promise<CommitActivity[]> {
  const perProject = await Promise.all(
    projects.map(async ({ cwd, name }) => {
      const raw = await fetchRawCommits(cwd)
      return raw.map((c) => ({
        cwd,
        project: name,
        sha: c.sha,
        subject: c.subject,
        ts: c.ts,
        isRelease: c.isRelease
      }))
    })
  )
  return perProject
    .flat()
    .filter((c) => c.ts > 0 && c.sha)
    .sort((a, b) => b.ts - a.ts)
}
