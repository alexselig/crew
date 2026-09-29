import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseProposal, reconcileProposal } from '../src/shared/conductor-proposal'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/conductor-proposals/${name}`, import.meta.url), 'utf8')

const reality = {
  models: ['gpt-6-astra', 'claude-opus-5', 'grok-4.7'],
  presets: ['copilot-cli', 'shell', 'claude']
}

describe('parseProposal', () => {
  it('reads a well-formed proposal', () => {
    const parsed = parseProposal(fixture('good.json'))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.rows).toHaveLength(2)
    expect(parsed.proposal.summary).toContain('importer')
  })

  // A missing or half-written file is a normal state, not an error: the agent
  // may simply not have finished.
  it('reports malformed JSON as not-ready rather than throwing', () => {
    const parsed = parseProposal(fixture('truncated.json'))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toBe('unreadable')
  })

  it('reports an empty file as not-ready', () => {
    expect(parseProposal('')).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects JSON that parses but is not a proposal', () => {
    expect(parseProposal('[1,2,3]')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(parseProposal('{"summary":"x"}')).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('tolerates the fenced code block agents habitually wrap JSON in', () => {
    const fenced = '```json\n' + fixture('good.json') + '\n```\n'
    expect(parseProposal(fenced).ok).toBe(true)
  })

  it('rejects the whole proposal when a row is missing a required field, rather than coercing or discarding it', () => {
    // No `kind` and no `rationale`: the old behaviour defaulted kind to
    // 'author' and rationale to ''. Untrusted input must fail closed here,
    // never produce a plausible-looking row out of missing data.
    const parsed = parseProposal('{"summary":"s","rows":[{"roleName":"a","presetId":"shell"}]}')
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a row whose kind is not author or reviewer', () => {
    const parsed = parseProposal(
      '{"summary":"s","rows":[{"roleName":"a","kind":"admin","presetId":"shell","model":null,"rationale":""}]}'
    )
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a row with an empty roleName or presetId', () => {
    expect(parseProposal(
      '{"summary":"s","rows":[{"roleName":"","kind":"author","presetId":"shell","model":null,"rationale":""}]}'
    )).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(parseProposal(
      '{"summary":"s","rows":[{"roleName":"a","kind":"author","presetId":"","model":null,"rationale":""}]}'
    )).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a row whose model is an empty string instead of null', () => {
    const parsed = parseProposal(
      '{"summary":"s","rows":[{"roleName":"a","kind":"author","presetId":"shell","model":"","rationale":""}]}'
    )
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a row whose model field is missing entirely', () => {
    const parsed = parseProposal(
      '{"summary":"s","rows":[{"roleName":"a","kind":"author","presetId":"shell","rationale":""}]}'
    )
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a row that is not an object', () => {
    const parsed = parseProposal('{"summary":"s","rows":["not-a-row"]}')
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects two rows proposing the same roleName', () => {
    const parsed = parseProposal(JSON.stringify({
      summary: 's',
      rows: [
        { roleName: 'a', kind: 'author', presetId: 'shell', model: null, rationale: '' },
        { roleName: 'a', kind: 'reviewer', presetId: 'shell', model: null, rationale: '' }
      ]
    }))
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects a narrative section that is not an object', () => {
    const parsed = parseProposal(JSON.stringify({
      summary: 's',
      rows: [],
      narrative: ['not-a-section']
    }))
    expect(parsed).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('rejects prototype-pollution keys on the top level, a row, and a narrative section', () => {
    expect(parseProposal('{"summary":"s","rows":[],"__proto__":{"polluted":true}}'))
      .toMatchObject({ ok: false, reason: 'unreadable' })
    expect(parseProposal(JSON.stringify({
      summary: 's',
      rows: [{ roleName: 'a', kind: 'author', presetId: 'shell', model: null, rationale: '', constructor: {} }]
    }))).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(parseProposal(JSON.stringify({
      summary: 's',
      rows: [],
      narrative: [{ heading: 'h', body: 'b', prototype: {} }]
    }))).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  // The reviewer reproduced the crash this guards against by monkey-patching
  // JSON.parse to hand back an object with a throwing getter — JSON.parse is
  // the real boundary an exotic parsed value crosses, so substituting it here
  // is a legitimate way to deliver one. Always restored in `finally`.
  it('reports a throwing getter on the top-level object as unreadable, not a crash', () => {
    const originalParse = JSON.parse
    try {
      JSON.parse = (): unknown => new Proxy({}, {
        get(_target, prop) {
          if (prop === 'rows') throw new Error('boom')
          return undefined
        }
      })
      expect(() => parseProposal('anything')).not.toThrow()
      expect(parseProposal('anything')).toMatchObject({ ok: false, reason: 'unreadable' })
    } finally {
      JSON.parse = originalParse
    }
  })

  it('reports a throwing getter on a nested row as unreadable, not a crash', () => {
    const originalParse = JSON.parse
    try {
      const hostileRow = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'roleName') throw new Error('boom')
          return undefined
        }
      })
      JSON.parse = (): unknown => ({ summary: 's', rows: [hostileRow] })
      expect(() => parseProposal('anything')).not.toThrow()
      expect(parseProposal('anything')).toMatchObject({ ok: false, reason: 'unreadable' })
    } finally {
      JSON.parse = originalParse
    }
  })
})

describe('reconcileProposal', () => {
  it('passes a proposal whose models and presets all exist', () => {
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    expect(result.notes).toEqual([])
    expect(result.rows.map((r) => r.roleName)).toEqual(['importer', 'reviewer'])
    expect(result.rows[0].agent.model).toBe('claude-opus-5')
  })

  // The rule this whole module exists for.
  it('flags a hallucinated model and does NOT substitute a default', () => {
    const parsed = parseProposal(fixture('hallucinated-model.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })

    expect(result.rows[0].agent.model).toBeNull()
    expect(result.notes).toContainEqual({
      row: 0,
      severity: 'blocking',
      message: 'gpt-9-omega is not an available model — choose one'
    })
    // Nothing silently picked for the user.
    expect(result.rows[0].agent.model).not.toBe('gpt-6-astra')
  })

  it('flags a preset the user has not installed', () => {
    const proposal = {
      summary: 's',
      narrative: [],
      rows: [{ roleName: 'a', kind: 'author' as const, presetId: 'opencode', model: null, rationale: '' }]
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 3 })
    expect(result.notes[0]).toMatchObject({ row: 0, severity: 'blocking' })
    expect(result.notes[0].message).toContain('opencode')
  })

  it('drops rows beyond maxLanes and says so, rather than truncating quietly', () => {
    const proposal = {
      summary: 's',
      narrative: [],
      rows: ['a', 'b', 'c'].map((roleName) => ({
        roleName, kind: 'author' as const, presetId: 'shell', model: null, rationale: ''
      }))
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 2 })
    expect(result.rows).toHaveLength(2)
    expect(result.notes).toContainEqual({
      row: -1,
      severity: 'warning',
      message: 'proposed 3 lanes; at most 2 are allowed, so 1 was dropped'
    })
  })

  it('carries each rationale through, because it is why the user trusts the row', () => {
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    expect(result.rows[1].rationale).toContain('not self-review')
  })

  it('produces rows the composer validator accepts when nothing is flagged', async () => {
    const { validateRoster } = await import('../src/shared/conductor-composer')
    const parsed = parseProposal(fixture('good.json'))
    if (!parsed.ok) throw new Error('fixture should parse')
    const result = reconcileProposal(parsed.proposal, reality, { maxLanes: 3 })
    const validation = validateRoster(
      { repo: '/tmp/repo', integrationBranch: 'crew/integration', rows: result.rows },
      { maxLanes: 3 }
    )
    expect(validation.ok).toBe(true)
  })

  it('never returns a row the user cannot fix in the form', () => {
    const proposal = {
      summary: 's',
      narrative: [],
      rows: [{ roleName: '', kind: 'author' as const, presetId: 'shell', model: null, rationale: '' }]
    }
    const result = reconcileProposal(proposal, reality, { maxLanes: 2 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].roleName).toBe('')
  })
})
