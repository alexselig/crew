import { describe, it, expect } from 'vitest'
import {
  makeAgentId,
  makeRunId,
  BUILTIN_AGENTS,
  buildAgentInvocation,
  validateAgent,
  upsertAgent,
  deleteAgent,
  reorderAgents
} from '../src/shared/agents'
import type { Agent } from '../src/shared/types'

const ag = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag_test',
  name: 'UX Critique',
  icon: 'spark',
  base: 'copilot-cli',
  persona: 'You are a UX critic. Do not edit files.',
  contextMode: 'cwd',
  writes: false,
  order: 0,
  ...over
})

describe('ids', () => {
  it('mints unique prefixed ids', () => {
    expect(makeAgentId()).toMatch(/^ag_[a-z0-9]{6,}$/)
    expect(makeRunId()).toMatch(/^run_[a-z0-9]{6,}$/)
    expect(makeAgentId()).not.toBe(makeAgentId())
  })
})

describe('BUILTIN_AGENTS', () => {
  it('ships several read-first specialists with unique ids + order', () => {
    expect(BUILTIN_AGENTS.length).toBeGreaterThanOrEqual(3)
    expect(new Set(BUILTIN_AGENTS.map((a) => a.id)).size).toBe(BUILTIN_AGENTS.length)
    expect(BUILTIN_AGENTS.every((a) => a.builtin)).toBe(true)
    expect(BUILTIN_AGENTS.some((a) => a.name === 'UX Critique')).toBe(true)
  })
})

describe('buildAgentInvocation (copilot)', () => {
  const base = { command: 'copilot', args: [] }
  it('read-first: -p prompt, deny write tools, no --allow-all-tools', () => {
    const { args } = buildAgentInvocation(base, ag({ writes: false }), 'Review the checkout', '')
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('You are a UX critic')
    expect(args[1]).toContain('Review the checkout')
    expect(args).toContain('--deny-tool')
    expect(args).not.toContain('--allow-all-tools')
  })
  it('writes: grants --allow-all-tools', () => {
    const { args } = buildAgentInvocation(base, ag({ writes: true }), 'Write docs', '')
    expect(args).toContain('--allow-all-tools')
  })
  it('appends extra context when provided', () => {
    const { args } = buildAgentInvocation(base, ag(), 'T', 'RECENT TRANSCRIPT')
    expect(args[1]).toContain('RECENT TRANSCRIPT')
  })
})

describe('buildAgentInvocation (claude)', () => {
  const base = { command: 'claude', args: [] }
  it('uses -p and text output, disallows edits when read-first', () => {
    const { args } = buildAgentInvocation(base, ag({ base: 'claude-code', writes: false }), 'T', '')
    expect(args).toContain('-p')
    expect(args).toContain('--output-format')
    expect(args).toContain('text')
    expect(args).toContain('--disallowedTools')
  })
})

describe('validate/crud', () => {
  it('rejects blank name/persona', () => {
    expect(validateAgent({ name: '', persona: 'x', base: 'copilot-cli' })).toBeTruthy()
    expect(validateAgent({ name: 'x', persona: '', base: 'copilot-cli' })).toBeTruthy()
    expect(validateAgent(ag())).toBeNull()
  })
  it('upsert/delete/reorder by id', () => {
    const a = ag({ id: 'ag_a', order: 0 })
    const b = ag({ id: 'ag_b', order: 1 })
    expect(upsertAgent([a], { ...a, name: 'X' }).find((x) => x.id === 'ag_a')?.name).toBe('X')
    expect(upsertAgent([a], b).map((x) => x.id)).toEqual(['ag_a', 'ag_b'])
    expect(deleteAgent([a, b], 'ag_a').map((x) => x.id)).toEqual(['ag_b'])
    expect(reorderAgents([a, b], ['ag_b', 'ag_a']).map((x) => [x.id, x.order])).toEqual([
      ['ag_b', 0],
      ['ag_a', 1]
    ])
  })
})
