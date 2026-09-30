import { describe, expect, it } from 'vitest'
import { UNSUPPORTED_CUSTOM_PRESET, validateRoster, type RosterDraft } from '../src/shared/conductor-composer'

function draft(overrides: Partial<RosterDraft> = {}): RosterDraft {
  return {
    repo: '/tmp/repo',
    integrationBranch: 'crew/integration',
    rows: [
      { roleName: 'builder', kind: 'author', agent: { presetId: 'copilot-cli', model: 'gpt-6-astra' } },
      { roleName: 'reviewer', kind: 'reviewer', agent: { presetId: 'copilot-cli', model: 'claude-opus-5' } }
    ],
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
