#!/usr/bin/env node
// Generate compact "handoff" briefs from Copilot CLI's local session store.
//
// WHY: resuming a session replays its whole events.jsonl. A 0.5 MB log costs
// ~1.4m tokens; multi-MB logs simply cannot be resumed at all. But everything
// needed to carry the work forward — the compaction checkpoints Copilot already
// writes, the files touched, the commits made, the user's own last words — is
// sitting in ~/.copilot/session-store.db. Reading it costs zero tokens.
//
// So we distil each conversation to a ~1-2k token brief on disk. A fresh agent
// primed with the brief knows the project, the decisions and the next steps
// without paying to relive the transcript.
//
// Usage:
//   node scripts/handoff.mjs                 # refresh every known session
//   node scripts/handoff.mjs <session-id>    # refresh one
//   node scripts/handoff.mjs --days 30       # only sessions used in last N days
//   node scripts/handoff.mjs --out <dir>

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DB = process.env.COPILOT_SESSION_DB || join(homedir(), '.copilot', 'session-store.db')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const OUT = flag('--out', join(homedir(), '.crew', 'handoffs'))
const DAYS = Number(flag('--days', '0')) || 0
const only = argv.filter((a) => /^[0-9a-f-]{36}$/i.test(a))

/** Budget per section, in characters (~4 chars per token). */
const BUDGET = { overview: 4500, turns: 1800, files: 900 }

function q(sql, params = []) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', DB, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: '',
    env: { ...process.env, ...Object.fromEntries(params.map((p, i) => [`P${i}`, p])) },
  })
  return out.trim() ? JSON.parse(out) : []
}
const esc = (s) => String(s).replace(/'/g, "''")
const clip = (s, n) => {
  const t = String(s || '').trim()
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + ' …[truncated]'
}
const slug = (s) =>
  String(s || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'session'

function sessions() {
  let where = "where s.cwd is not null"
  if (only.length) where += ` and s.id in (${only.map((i) => `'${esc(i)}'`).join(',')})`
  else if (DAYS) where += ` and s.updated_at >= datetime('now','-${DAYS} days')`
  return q(`
    select s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at,
           (select count(*) from turns t where t.session_id = s.id) as turn_count
    from sessions s ${where}
    order by s.updated_at desc`)
}

function brief(s) {
  const cps = q(
    `select checkpoint_number, title, overview from checkpoints
     where session_id='${esc(s.id)}' order by checkpoint_number`
  )
  const turns = q(
    `select user_message, assistant_response from turns
     where session_id='${esc(s.id)}' and coalesce(user_message,'') <> ''
     order by turn_index desc limit 6`
  )
  const files = q(
    `select file_path, count(*) as n from session_files
     where session_id='${esc(s.id)}' group by file_path order by n desc limit 12`
  )
  const refs = q(
    `select ref_type, ref_value from session_refs
     where session_id='${esc(s.id)}' order by created_at desc limit 8`
  )

  const title = cps.at(-1)?.title || s.summary || clip(turns.at(-1)?.user_message, 70) || 'Untitled session'

  // The newest checkpoint is the most accurate picture of the end state; older
  // ones only matter for how we got there, so they get a much smaller ration.
  const latest = cps.at(-1)?.overview || ''
  const earlier = cps.slice(0, -1).map((c) => `- **${c.title}** — ${clip(c.overview, 260)}`)

  const L = []
  L.push('---')
  L.push(`agentSessionId: ${s.id}`)
  L.push(`cwd: ${s.cwd}`)
  if (s.repository) L.push(`repository: ${s.repository}`)
  if (s.branch) L.push(`branch: ${s.branch}`)
  L.push(`turns: ${s.turn_count}`)
  L.push(`lastUsed: ${s.updated_at}`)
  L.push(`generated: ${new Date().toISOString()}`)
  L.push('---', '')
  L.push(`# ${title}`, '')
  L.push(
    '> Context brief rebuilt from the local Copilot session store. It replaces replaying',
    '> the transcript. Treat it as the current state of this work.',
    ''
  )

  if (s.summary && s.summary !== title) L.push('## Summary', '', clip(s.summary, 700), '')

  if (latest) L.push('## Where things stand', '', clip(latest, BUDGET.overview), '')
  if (earlier.length) L.push('## How we got here', '', ...earlier, '')

  if (turns.length) {
    L.push('## The last things I asked for', '')
    for (const t of [...turns].reverse()) L.push(`- ${clip(t.user_message, BUDGET.turns / turns.length)}`)
    L.push('')
  }

  if (files.length) {
    L.push('## Files this work touches', '')
    for (const f of files) L.push(`- \`${f.file_path}\``)
    L.push('')
  }

  if (refs.length) {
    L.push('## References', '')
    for (const r of refs) L.push(`- ${r.ref_type}: ${r.ref_value}`)
    L.push('')
  }

  L.push('## If you need the raw transcript', '')
  L.push(`\`copilot --resume=${s.id}\`  — full replay, expensive; prefer this brief.`, '')

  return { title, body: L.join('\n') }
}

mkdirSync(OUT, { recursive: true })
const all = sessions()
const written = []
for (const s of all) {
  // A session with nothing recorded yields a brief with nothing in it.
  if (!s.turn_count) continue
  const { title, body } = brief(s)
  const name = `${slug(title)}--${s.id.slice(0, 8)}.md`
  writeFileSync(join(OUT, name), body)
  written.push({ name, title, id: s.id, chars: body.length, updated: s.updated_at, cwd: s.cwd })
}

// Drop briefs for sessions that no longer exist, so the folder stays truthful.
const keep = new Set(written.map((w) => w.name).concat(['INDEX.md']))
for (const f of readdirSync(OUT)) {
  if (f.endsWith('.md') && !keep.has(f)) unlinkSync(join(OUT, f))
}

written.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
const idx = [
  '# Session handoffs',
  '',
  `${written.length} briefs, regenerated ${new Date().toISOString()}.`,
  'Each replaces a full transcript replay. Point a fresh agent at one to pick up the work.',
  '',
  '| Last used | Brief | Tokens (approx) |',
  '| --- | --- | --- |',
  ...written.map((w) => `| ${String(w.updated).slice(0, 10)} | [${w.title}](./${w.name}) | ~${Math.round(w.chars / 4)} |`),
  '',
]
writeFileSync(join(OUT, 'INDEX.md'), idx.join('\n'))

const chars = written.reduce((n, w) => n + w.chars, 0)
console.log(`wrote ${written.length} briefs to ${OUT}`)
console.log(`total ~${Math.round(chars / 4).toLocaleString()} tokens for the entire roster`)
