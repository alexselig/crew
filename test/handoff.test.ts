import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefPathFor, primerFor, resolveContext, AUTO_BRIEF_BYTES } from '../src/main/handoff'

describe('handoff briefs', () => {
  let dir: string
  const id = '2ac8d4b6-9a7c-4e2a-809f-c6aa2be9da4c'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-handoff-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds a brief by the id suffix, whatever the slug says', () => {
    writeFileSync(join(dir, 'fix-icon-positioning-bug--2ac8d4b6.md'), '# brief')
    expect(briefPathFor(id, dir)).toBe(join(dir, 'fix-icon-positioning-bug--2ac8d4b6.md'))
  })

  it('does not match a different conversation', () => {
    writeFileSync(join(dir, 'something-else--deadbeef.md'), '# brief')
    expect(briefPathFor(id, dir)).toBeNull()
  })

  it('treats a missing brief folder as a normal state, not an error', () => {
    expect(briefPathFor(id, join(dir, 'nope'))).toBeNull()
  })

  it('has nothing to look up without a prior conversation', () => {
    expect(briefPathFor(undefined, dir)).toBeNull()
  })

  it('ignores a brief that only shares a prefix with the id suffix', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'x--2ac8d4b6.markdown'), '# not a brief')
    expect(briefPathFor(id, dir)).toBeNull()
  })

  it('primes on a single line so it is typed, never submitted', () => {
    const primer = primerFor('/tmp/brief.md')
    expect(primer).toContain('/tmp/brief.md')
    expect(primer).not.toContain('\n')
    expect(primer).not.toContain('\r')
  })
})

describe('resolveContext', () => {
  const ID = 'abc'
  const args = ['--continue']

  it('reattaches the conversation in transcript mode', () => {
    const c = resolveContext({ agentSessionId: ID, resume: true, contextMode: 'transcript', resumeArgs: args })
    expect(c.agentSessionId).toBe(ID)
    expect(c.extraArgs).toEqual(args)
  })

  it('supersedes with a fresh agent in brief mode, keeping the old id', () => {
    const c = resolveContext({ agentSessionId: ID, resume: true, contextMode: 'brief', resumeArgs: args })
    expect(c.agentSessionId).toBeUndefined()
    expect(c.priorSessionId).toBe(ID)
    // Replay flags would drag the transcript back in and defeat the point.
    expect(c.extraArgs).toEqual([])
  })

  it('never drops a known conversation id, even with resume off', () => {
    const c = resolveContext({ agentSessionId: ID, resume: false, contextMode: 'transcript', resumeArgs: args })
    expect(c.agentSessionId).toBeUndefined()
    expect(c.priorSessionId).toBe(ID)
  })

  it('has nothing to carry for a session that never had a conversation', () => {
    const c = resolveContext({ agentSessionId: undefined, resume: true, contextMode: 'brief' })
    expect(c.agentSessionId).toBeUndefined()
    expect(c.priorSessionId).toBeUndefined()
  })

  it('always yields exactly one id, so a transcript is never orphaned', () => {
    for (const resume of [true, false])
      for (const contextMode of ['transcript', 'brief'] as const) {
        const c = resolveContext({ agentSessionId: ID, resume, contextMode })
        expect([c.agentSessionId, c.priorSessionId].filter(Boolean)).toEqual([ID])
      }
  })
})

describe('auto context mode', () => {
  const ID = 'abc'
  const args = ['--continue']
  const auto = (transcriptBytes: number, hasBrief = true): ReturnType<typeof resolveContext> =>
    resolveContext({
      agentSessionId: ID,
      resume: true,
      contextMode: 'auto',
      resumeArgs: args,
      transcriptBytes,
      hasBrief
    })

  it('replays the whole conversation while the history is short', () => {
    const c = auto(64 * 1024)
    expect(c.agentSessionId).toBe(ID)
    expect(c.extraArgs).toEqual(args)
  })

  it('still replays right up to the threshold', () => {
    expect(auto(AUTO_BRIEF_BYTES - 1).agentSessionId).toBe(ID)
  })

  it('switches to the brief once the history outgrows it', () => {
    const c = auto(AUTO_BRIEF_BYTES)
    expect(c.agentSessionId).toBeUndefined()
    expect(c.priorSessionId).toBe(ID)
    expect(c.extraArgs).toEqual([])
  })

  it('replays a huge history anyway when no brief exists', () => {
    // Superseding without a brief restores nothing at all, which is strictly
    // worse than a transcript that may not fit.
    expect(auto(500 * 1024 * 1024, false).agentSessionId).toBe(ID)
  })

  it('treats an unmeasurable history as short', () => {
    const c = resolveContext({ agentSessionId: ID, resume: true, contextMode: 'auto', resumeArgs: args })
    expect(c.agentSessionId).toBe(ID)
  })

  it('still honours resume being switched off', () => {
    const c = resolveContext({ agentSessionId: ID, resume: false, contextMode: 'auto', transcriptBytes: 1 })
    expect(c.agentSessionId).toBeUndefined()
    expect(c.priorSessionId).toBe(ID)
  })
})
