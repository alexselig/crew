import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
    mkdirSync(out)
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

  it('replaces an older slug for the refreshed session', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-handoff-rename-'))
    roots.push(root)
    const db = join(root, 'sessions.db')
    const out = join(root, 'handoffs')
    const id = '11111111-1111-4111-8111-111111111111'
    mkdirSync(out)
    execFileSync('sqlite3', [
      db,
      `create table sessions (id text, cwd text, repository text, branch text, summary text, created_at text, updated_at text);
       create table turns (session_id text, turn_index integer, user_message text, assistant_response text, timestamp text);
       create table checkpoints (session_id text, checkpoint_number integer, title text, overview text, history text, work_done text, technical_details text, important_files text, next_steps text);
       create table session_files (session_id text, file_path text);
       create table session_refs (session_id text, ref_type text, ref_value text, created_at text);
       insert into sessions values ('${id}', '/tmp/one', null, null, 'New title', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z');
       insert into turns values ('${id}', 0, 'first', 'reply', '2026-09-10T01:00:00Z');`
    ])
    writeFileSync(join(out, `old-title--${id.slice(0, 8)}.md`), '# stale brief')

    execFileSync('node', [resolve('scripts/handoff.mjs'), id, '--out', out], {
      cwd: resolve('.'),
      env: { ...process.env, COPILOT_SESSION_DB: db }
    })

    expect(readdirSync(out).filter((f) => f.endsWith(`--${id.slice(0, 8)}.md`))).toEqual([
      `new-title--${id.slice(0, 8)}.md`
    ])
  })

  it('keeps the existing index and unrelated briefs during a days refresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-handoff-days-'))
    roots.push(root)
    const db = join(root, 'sessions.db')
    const out = join(root, 'handoffs')
    mkdirSync(out)
    execFileSync('sqlite3', [
      db,
      `create table sessions (id text, cwd text, repository text, branch text, summary text, created_at text, updated_at text);
       create table turns (session_id text, turn_index integer, user_message text, assistant_response text, timestamp text);
       create table checkpoints (session_id text, checkpoint_number integer, title text, overview text, history text, work_done text, technical_details text, important_files text, next_steps text);
       create table session_files (session_id text, file_path text);
       create table session_refs (session_id text, ref_type text, ref_value text, created_at text);
       insert into sessions values ('11111111-1111-4111-8111-111111111111', null, null, null, 'Recent', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
       insert into turns values ('11111111-1111-4111-8111-111111111111', 0, 'recent', 'reply', datetime('now','-1 day'));`
    ])
    writeFileSync(join(out, 'INDEX.md'), '# existing complete index')
    writeFileSync(join(out, 'older--22222222.md'), '# older brief')

    execFileSync('node', [resolve('scripts/handoff.mjs'), '--days', '7', '--out', out], {
      cwd: resolve('.'),
      env: { ...process.env, COPILOT_SESSION_DB: db }
    })

    expect(readFileSync(join(out, 'INDEX.md'), 'utf8')).toBe('# existing complete index')
    expect(readdirSync(out)).toContain('older--22222222.md')
    expect(readFileSync(join(out, 'recent--11111111.md'), 'utf8')).not.toContain('\ncwd:')
  })

  it('prunes orphaned briefs and rebuilds the index during a full refresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-handoff-full-'))
    roots.push(root)
    const db = join(root, 'sessions.db')
    const out = join(root, 'handoffs')
    mkdirSync(out)
    execFileSync('sqlite3', [
      db,
      `create table sessions (id text, cwd text, repository text, branch text, summary text, created_at text, updated_at text);
       create table turns (session_id text, turn_index integer, user_message text, assistant_response text, timestamp text);
       create table checkpoints (session_id text, checkpoint_number integer, title text, overview text, history text, work_done text, technical_details text, important_files text, next_steps text);
       create table session_files (session_id text, file_path text);
       create table session_refs (session_id text, ref_type text, ref_value text, created_at text);
       insert into sessions values ('11111111-1111-4111-8111-111111111111', '/tmp/recent', null, null, 'Recent', '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z');
       insert into turns values ('11111111-1111-4111-8111-111111111111', 0, 'recent', 'reply', '2026-09-10T01:00:00Z');`
    ])
    writeFileSync(join(out, 'orphan--22222222.md'), '# orphan')

    execFileSync('node', [resolve('scripts/handoff.mjs'), '--out', out], {
      cwd: resolve('.'),
      env: { ...process.env, COPILOT_SESSION_DB: db }
    })

    expect(readdirSync(out)).not.toContain('orphan--22222222.md')
    expect(readFileSync(join(out, 'INDEX.md'), 'utf8')).toContain('[Recent](./recent--11111111.md)')
  })
})
