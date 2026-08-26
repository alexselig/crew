#!/usr/bin/env node
// Generate compact "handoff" briefs from Copilot CLI's local session store.
//
// WHY: resuming a session replays its whole events.jsonl. A 0.5 MB log costs
// ~1.4m tokens; multi-MB logs simply cannot be resumed at all. But everything
// needed to carry the work forward — the compaction checkpoints Copilot already
// writes, the files touched, the commits made, the user's own last words — is
// sitting in ~/.copilot/session-store.db. Reading it costs zero tokens.
//
// So we distil each conversation to a brief on disk — a few thousand tokens
// against a transcript's hundreds of thousands. The aim is to get as close to
// the transcript as the budget allows, so the brief reproduces Copilot's own
// checkpoint fields (overview, work done, technical details, key files, next
// steps, history) rather than the overview alone, and quotes both sides of the
// closing exchanges with the newest turns weighted heaviest. A fresh agent
// primed with the brief knows the project, the decisions, what was actually
// said and what remains, without paying to relive the transcript.
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
import { pathToFileURL } from 'node:url'

const DB = process.env.COPILOT_SESSION_DB || join(homedir(), '.copilot', 'session-store.db')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const OUT = flag('--out', join(homedir(), '.crew', 'handoffs'))
const DAYS = Number(flag('--days', '0')) || 0
const only = argv.filter((a) => /^[0-9a-f-]{36}$/i.test(a))

/** Budget per section, in characters (~4 chars per token).
 *
 * Sized against what the store actually holds rather than an arbitrary target.
 * Copilot's own checkpoint fields average 1.0k (overview), 2.2k (work_done),
 * 4.2k (technical_details), 4.2k (history) and 1.6k (next_steps) characters and
 * peak around 13k, so these budgets carry the newest checkpoint essentially
 * whole. That is the point: a checkpoint *is* the model's own compaction of the
 * transcript, so reproducing it in full is the closest a brief can get to a
 * replay while still costing a few thousand tokens instead of a million. */
const BUDGET = {
  summary: 900,
  standing: 6000,
  workDone: 6000,
  technical: 9000,
  keyFiles: 3500,
  nextSteps: 4000,
  history: 9000,
  earlier: 900,
  earlierTotal: 7000,
  turns: 14000,
  turnFloor: 320,
  turnCeiling: 5000
}

/** How many trailing turns to quote, newest first. */
const TURN_WINDOW = 14
/** Each older turn gets this fraction of the one after it. The tail of a
 *  conversation is what a successor actually needs; the middle is what the
 *  checkpoints above already summarise. */
const TURN_DECAY = 0.72

/**
 * Split a character budget across turns, newest-heaviest.
 *
 * Flat rationing was the old behaviour and it was the wrong shape: it spent as
 * much on a turn from an hour ago as on the one that was interrupted, and
 * clipped both to uselessness.
 */
export function rations(count, total) {
  const weights = Array.from({ length: count }, (_, i) => TURN_DECAY ** i)
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) =>
    Math.max(BUDGET.turnFloor, Math.min(BUDGET.turnCeiling, Math.round((w / sum) * total)))
  )
}

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
  // Every checkpoint column, not just the overview. history / work_done /
  // technical_details / next_steps are where the substance lives, and dropping
  // them was why briefs read as thin next to the conversations they replaced.
  const cps = q(
    `select checkpoint_number, title, overview, history, work_done,
            technical_details, important_files, next_steps
     from checkpoints where session_id='${esc(s.id)}' order by checkpoint_number`
  )
  const turns = q(
    `select user_message, assistant_response from turns
     where session_id='${esc(s.id)}' and coalesce(user_message,'') <> ''
     order by turn_index desc limit ${TURN_WINDOW}`
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
  const last = cps.at(-1) || {}
  let spent = 0
  const earlier = []
  for (const c of cps.slice(0, -1).reverse()) {
    const text = clip(c.overview, BUDGET.earlier)
    if (spent + text.length > BUDGET.earlierTotal) break
    spent += text.length
    earlier.unshift(`- **${c.title}** — ${text}`)
  }

  const L = []
  L.push('---')
  L.push(`agentSessionId: ${s.id}`)
  L.push(`cwd: ${s.cwd}`)
  if (s.repository) L.push(`repository: ${s.repository}`)
  if (s.branch) L.push(`branch: ${s.branch}`)
  L.push(`turns: ${s.turn_count}`)
  L.push(`checkpoints: ${cps.length}`)
  L.push(`lastUsed: ${s.updated_at}`)
  L.push(`generated: ${new Date().toISOString()}`)
  L.push('---', '')
  L.push(`# ${title}`, '')
  L.push(
    '> Context brief rebuilt from the local Copilot session store — the agent\'s own',
    '> compaction checkpoints plus the closing exchanges verbatim. It replaces replaying',
    '> the transcript. Treat it as the current state of this work.',
    ''
  )

  if (s.summary && s.summary !== title) L.push('## Summary', '', clip(s.summary, 700), '')

  const section = (heading, text, budget) => {
    const body = clip(text, budget)
    if (body) L.push(`## ${heading}`, '', body, '')
  }

  section('Where things stand', last.overview, BUDGET.standing)
  section('What has been done', last.work_done, BUDGET.workDone)
  section('Technical details', last.technical_details, BUDGET.technical)
  section('Key files', last.important_files, BUDGET.keyFiles)
  section('Next steps', last.next_steps, BUDGET.nextSteps)
  section('How we got here', last.history, BUDGET.history)

  if (earlier.length) L.push('## Earlier checkpoints', '', ...earlier, '')

  if (turns.length) {
    // Both sides of the exchange, newest-heaviest. Quoting only what the user
    // asked left a successor guessing what was answered — the half of the
    // conversation that carries the decisions.
    L.push('## How the conversation ended', '')
    const budgets = rations(turns.length, BUDGET.turns)
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      const n = budgets[i]
      L.push(`**Asked:** ${clip(t.user_message, n)}`, '')
      const replied = clip(t.assistant_response, n)
      if (replied) L.push(`**Replied:** ${replied}`, '')
    }
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

// Only do the work when run as a script; importing this file (tests) must not
// touch the session store or the handoff folder.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()

function main() {
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
}
