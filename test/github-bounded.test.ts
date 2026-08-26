import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveGithubUrl, _resetGithubUrlCache, _gitSpawnCount } from '../src/main/github'

/**
 * Guard for the 2026-08-26 process-table exhaustion.
 *
 * The session header's GitHub chip re-resolves on every mount and on window
 * focus. resolveGithubUrl shelled out to `git` each time, uncached, so a burst
 * of re-renders across a full roster spawned one git per session per render.
 * That reached ~2,000 concurrent `git remote get-url origin` processes, hit the
 * per-user process limit ("fork: Resource temporarily unavailable"), and left
 * the app flickering and unusable.
 *
 * Counting spawns directly is the only assertion that would have caught it.
 */
describe('resolveGithubUrl is bounded', () => {
  let repo: string

  beforeEach(() => {
    _resetGithubUrlCache()
    repo = mkdtempSync(join(tmpdir(), 'crew-gh-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { cwd: repo })
  })

  it('resolves the remote', async () => {
    await expect(resolveGithubUrl(repo)).resolves.toBe('https://github.com/acme/widget')
  })

  it('collapses a burst of concurrent callers into a single resolution', async () => {
    const burst = await Promise.all(Array.from({ length: 200 }, () => resolveGithubUrl(repo)))
    expect(new Set(burst)).toEqual(new Set(['https://github.com/acme/widget']))
    // The whole point: 200 callers must not become 200 processes.
    expect(_gitSpawnCount()).toBe(1)
  })

  it('serves repeat calls from cache instead of spawning again', async () => {
    await resolveGithubUrl(repo)
    // Break the remote: a cached answer must not notice within the TTL, which
    // proves no second git ran.
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/CHANGED.git'], { cwd: repo })
    await expect(resolveGithubUrl(repo)).resolves.toBe('https://github.com/acme/widget')
  })

  it('re-reads once the cache is dropped', async () => {
    await resolveGithubUrl(repo)
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://github.com/acme/CHANGED.git'], { cwd: repo })
    _resetGithubUrlCache()
    await expect(resolveGithubUrl(repo)).resolves.toBe('https://github.com/acme/CHANGED')
  })

  it('caches the negative answer for a directory with no remote', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'crew-gh-none-'))
    await expect(resolveGithubUrl(bare)).resolves.toBeNull()
    await expect(resolveGithubUrl(bare)).resolves.toBeNull()
  })
})
