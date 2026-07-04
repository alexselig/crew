// Reads the skills actually installed on disk so the Skills picker reflects what
// the session's agent can really invoke, instead of a hardcoded list.
//
// Copilot CLI loads personal skills from ~/.copilot/skills; Claude Code from
// ~/.claude/skills. Each skill is a directory with a SKILL.md whose YAML
// frontmatter carries `name:` (the invoke token) and `description:`.

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { InstalledSkill } from '../shared/api'

function skillsLocation(agent: string): { dir: string; source: InstalledSkill['source'] } | null {
  const a = (agent || '').toLowerCase()
  if (a.includes('claude')) return { dir: join(homedir(), '.claude', 'skills'), source: 'claude' }
  // Copilot CLI is the default agent, and where the user's g_ skills live.
  if (a.includes('copilot') || a === '') return { dir: join(homedir(), '.copilot', 'skills'), source: 'copilot' }
  return { dir: join(homedir(), '.copilot', 'skills'), source: 'copilot' }
}

// Read just the head of a file — frontmatter lives at the very top, and some
// SKILL.md files are tens of KB, so we avoid loading them whole.
function readHead(file: string, bytes = 8192): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

function frontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  const fm = end === -1 ? md.slice(3) : md.slice(3, end)
  const lines = fm.split('\n')

  const nameLine = lines.find((l) => /^name:/.test(l))
  const name = nameLine
    ? nameLine.replace(/^name:\s*/, '').trim().replace(/^["']|["']$/g, '')
    : undefined

  let description = ''
  const descIdx = lines.findIndex((l) => /^description:/.test(l))
  if (descIdx >= 0) {
    const inline = lines[descIdx].replace(/^description:\s*/, '').trim()
    if (inline && inline !== '|' && inline !== '>' && !inline.startsWith('|') && !inline.startsWith('>')) {
      description = inline
    } else {
      // Block scalar: gather the indented lines that follow.
      const buf: string[] = []
      for (let i = descIdx + 1; i < lines.length; i++) {
        if (/^\s+\S/.test(lines[i])) buf.push(lines[i].trim())
        else if (lines[i].trim() === '') continue
        else break
      }
      description = buf.join(' ')
    }
  }
  return { name, description: shorten(description) }
}

function shorten(raw: string, max = 160): string {
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const dot = clean.indexOf('. ')
  let s = dot > 20 && dot < max ? clean.slice(0, dot + 1) : clean
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…'
  return s
}

/**
 * List the skills installed for the given agent (by its command, e.g. "copilot"
 * or "claude"). Returns an empty array when the skills directory is absent.
 */
export function listInstalledSkills(agent: string): InstalledSkill[] {
  const loc = skillsLocation(agent)
  if (!loc) return []
  let entries: string[]
  try {
    entries = readdirSync(loc.dir)
  } catch {
    return []
  }
  const out: InstalledSkill[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const dir = join(loc.dir, entry)
    const md = join(dir, 'SKILL.md')
    let head: string
    try {
      if (!statSync(dir).isDirectory()) continue
      head = readHead(md)
    } catch {
      continue
    }
    const { name, description } = frontmatter(head)
    const skillName = (name || entry).trim()
    if (!skillName || seen.has(skillName)) continue // Copilot identifies/dedups by name.
    seen.add(skillName)
    out.push({ id: `${loc.source}:${skillName}`, name: skillName, description: description || '', source: loc.source })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}
