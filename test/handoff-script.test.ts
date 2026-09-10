import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('handoff script cleanup', () => {
  it('does not delete unrelated briefs during a single-session refresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-handoff-script-'))
    roots.push(root)
    const db = join(root, 'sessions.db')
    const out = join(root, 'handoffs')
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    execFileSync('mkdir', ['-p', out])
    execFileSync('sqlite3', [
      db,
      `create table sessions (id text, cwd text, repository text, branch text, summary text, created_at text, updated_at text);
       create table turns (session_id text, turn_index integer, user_message text, assistant_response text, timestamp text);
       create table checkpoints (session_id text, checkpoint_number integer, title text, overview text, history text, work_done text, technical_details text, important_files text, next_steps text);
       create table session_files (session_id text, file_path text);
       create table session_refs (session_id text, ref_type text, ref_value text, created_at text);
       insert into sessions values ('${first}', '/tmp/one', null, null, 'One', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z');
       insert into sessions values ('${second}', '/tmp/two', null, null, 'Two', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z');
       insert into turns values ('${first}', 0, 'first', 'reply', '2026-09-10T01:00:00Z');
       insert into turns values ('${second}', 0, 'second', 'reply', '2026-09-10T01:00:00Z');`
    ])
    const unrelated = join(out, `two--${second.slice(0, 8)}.md`)
    writeFileSync(unrelated, '# existing brief')

    execFileSync('node', [resolve('scripts/handoff.mjs'), first, '--out', out], {
      cwd: resolve('.'),
      env: { ...process.env, COPILOT_SESSION_DB: db }
    })

    expect(readdirSync(out)).toContain(`two--${second.slice(0, 8)}.md`)
  })
})
