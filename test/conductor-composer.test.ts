import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { UNSUPPORTED_CUSTOM_PRESET, validateRoster, type RosterDraft } from '../src/shared/conductor-composer'
import { parseSource, hasNamedImport, findFunctionVariable, findCallsTo, findAll, flattenPropertyAccess } from './helpers/ts-ast'

function draft(overrides: Partial<RosterDraft> = {}): RosterDraft {
  return {
    repo: '/tmp/repo',
    integrationBranch: 'crew/integration',
    rows: [
      { roleName: 'builder', kind: 'author', agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' } },
      { roleName: 'reviewer', kind: 'reviewer', agent: { presetId: 'copilot-cli', model: 'claude-opus-5' } }
    ],
    test: null,
    ...overrides
  }
}

describe('validateRoster', () => {
  it('accepts a well-formed roster', () => {
    const result = validateRoster(draft(), { maxLanes: 2 })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects an empty roster, because a run with no lanes conducts nothing', () => {
    const result = validateRoster(draft({ rows: [] }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows', message: 'add at least one lane' })
  })

  it('rejects duplicate role names, which would collide as branch names', () => {
    const rows = draft().rows.map((row) => ({ ...row, roleName: 'builder' }))
    const result = validateRoster(draft({ rows }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows[1].roleName', message: 'duplicate role name' })
  })

  it('rejects a role name that is not legal in a branch ref', () => {
    const rows = [{ ...draft().rows[0], roleName: 'a lane..name' }]
    const result = validateRoster(draft({ rows }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe('rows[0].roleName')
  })

  it('rejects more rows than maxLanes', () => {
    const result = validateRoster(draft(), { maxLanes: 1 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows', message: 'at most 1 lane' })
  })

  it('requires a model for copilot-cli and forbids one where the preset takes none', () => {
    const missing = validateRoster(
      draft({ rows: [{ roleName: 'builder', kind: 'author', agent: { presetId: 'copilot-cli', model: null } }] }),
      { maxLanes: 2 }
    )
    expect(missing.errors).toContainEqual({ field: 'rows[0].agent.model', message: 'choose a model' })

    const spurious = validateRoster(
      draft({ rows: [{ roleName: 'builder', kind: 'author', agent: { presetId: 'shell', model: 'gpt-6-astra' } }] }),
      { maxLanes: 2 }
    )
    expect(spurious.errors).toContainEqual({ field: 'rows[0].agent.model', message: 'this preset takes no model' })
  })

  it('reports every problem at once, so the user fixes the form in one pass', () => {
    const result = validateRoster(
      draft({ integrationBranch: '', rows: [{ roleName: '', kind: 'author', agent: { presetId: '', model: null } }] }),
      { maxLanes: 2 }
    )
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('rejects an integration branch that collides with a role branch', () => {
    const result = validateRoster(draft({ integrationBranch: 'crew/lane/builder' }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({
      field: 'integrationBranch',
      message: 'this is the branch lane "builder" would use'
    })
  })

  // RosterRow carries only presetId/model (no command/args), so a row using
  // the composer form's old "Custom command…" sentinel could never actually
  // be honoured by composeRun — it must fail validation like any other
  // unchosen agent, not silently pass through as if it meant something.
  it('rejects the unsupported custom-command sentinel as if no agent had been chosen', () => {
    const rows = [{
      roleName: 'builder',
      kind: 'author' as const,
      agent: { presetId: UNSUPPORTED_CUSTOM_PRESET, model: null }
    }]
    const result = validateRoster(draft({ rows }), { maxLanes: 2 })
    expect(result.ok).toBe(false)
    expect(result.errors).toContainEqual({ field: 'rows[0].agent.presetId', message: 'choose an agent' })
  })
})

describe('ConductorComposer.tsx — never claims a failed compose left nothing behind', () => {
  // The component itself renders nothing under vitest's node-only config;
  // this pins the WIRING (the pure text of describeComposeFailure is
  // covered directly in conductor-view-model.test.ts) — that submit routes
  // through it rather than a shortcut like `'message' in result` that drops
  // survivingLanes on the floor (Task 5 finding 3, re-broken once already).
  //
  // Task 7 fix round 1, Finding 2: previously a plain source-text scan
  // (indexOf/regex), which still passes if the real wiring is deleted and
  // replaced by a comment or string literal containing the same text. This
  // walks the real TypeScript AST instead, so the assertion requires an
  // actual CallExpression (and the absence of an actual `in` BinaryExpression).
  const source = parseSource('src/renderer/components/ConductorComposer.tsx')

  it('imports describeComposeFailure via a real import declaration from the pure view-model', () => {
    expect(hasNamedImport(source, '../conductor-view-model', 'describeComposeFailure')).toBe(true)
  })

  it('routes the submit failure through a real describeComposeFailure(result) call, not a string-matched shortcut', () => {
    const submit = findFunctionVariable(source, 'submit')
    expect(submit).toBeDefined()
    const body = submit!.body

    const setSubmitErrorCalls = findCallsTo(body, 'setSubmitError')
    expect(setSubmitErrorCalls.some((call) => {
      const arg = call.arguments[0]
      return arg !== undefined && ts.isCallExpression(arg) &&
        flattenPropertyAccess(arg.expression) === 'describeComposeFailure' &&
        arg.arguments[0]?.getText() === 'result'
    })).toBe(true)

    // The regression this guards against used `'message' in result` as a
    // shortcut instead — assert no real `in` expression exists in the body
    // at all, not just that the particular substring is absent.
    const inExpressions = findAll(body, ts.isBinaryExpression).filter(
      (b) => b.operatorToken.kind === ts.SyntaxKind.InKeyword
    )
    expect(inExpressions).toHaveLength(0)
  })
})
