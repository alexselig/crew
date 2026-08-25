import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { githubUrlFrom, isGithubUrl } from '../src/shared/github'
import { resolveGithubUrl } from '../src/main/github'

describe('githubUrlFrom', () => {
  it('normalizes an https remote and strips the .git suffix', () => {
    expect(githubUrlFrom('https://github.com/alexselig/crew.git')).toBe(
      'https://github.com/alexselig/crew'
    )
  })

  it('converts an scp-style git@ remote to an https URL', () => {
    expect(githubUrlFrom('git@github.com:alexselig/crew.git')).toBe(
      'https://github.com/alexselig/crew'
    )
  })

  it('passes through an https remote without a .git suffix', () => {
    expect(githubUrlFrom('https://github.com/alexselig/crew')).toBe(
      'https://github.com/alexselig/crew'
    )
  })

  it('returns null for empty / non-url remotes', () => {
    expect(githubUrlFrom('')).toBeNull()
    expect(githubUrlFrom('   ')).toBeNull()
    expect(githubUrlFrom('not-a-remote')).toBeNull()
  })
})

describe('isGithubUrl', () => {
  it('accepts github.com URLs (with or without www)', () => {
    expect(isGithubUrl('https://github.com/alexselig/crew')).toBe(true)
    expect(isGithubUrl('https://www.github.com/alexselig/crew')).toBe(true)
  })

  it('rejects non-github hosts and null', () => {
    expect(isGithubUrl('https://gitlab.com/alexselig/crew')).toBe(false)
    expect(isGithubUrl('https://example.com/x')).toBe(false)
    expect(isGithubUrl(null)).toBe(false)
  })

  it('composes with githubUrlFrom for a GitLab ssh remote (not GitHub)', () => {
    expect(isGithubUrl(githubUrlFrom('git@gitlab.com:me/repo.git'))).toBe(false)
  })
})

describe('resolveGithubUrl (real git repo)', () => {
  const dirs: string[] = []
  const makeRepo = (origin?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-gh-test-'))
    dirs.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir })
    return dir
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('resolves a GitHub ssh origin to its https URL', async () => {
    const dir = makeRepo('git@github.com:alexselig/crew.git')
    expect(await resolveGithubUrl(dir)).toBe('https://github.com/alexselig/crew')
  })

  it('resolves a GitHub https origin (strips .git)', async () => {
    const dir = makeRepo('https://github.com/alexselig/crew.git')
    expect(await resolveGithubUrl(dir)).toBe('https://github.com/alexselig/crew')
  })

  it('returns null for a repo whose origin is not GitHub', async () => {
    const dir = makeRepo('git@gitlab.com:me/repo.git')
    expect(await resolveGithubUrl(dir)).toBeNull()
  })

  it('returns null for a git repo with no origin remote', async () => {
    const dir = makeRepo()
    expect(await resolveGithubUrl(dir)).toBeNull()
  })

  it('returns null for a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-nogit-'))
    dirs.push(dir)
    expect(await resolveGithubUrl(dir)).toBeNull()
  })

  it('returns null for an empty cwd', async () => {
    expect(await resolveGithubUrl('')).toBeNull()
  })
})
