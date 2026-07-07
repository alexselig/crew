import { describe, it, expect } from 'vitest'
import { CHECKPOINT_PROMPT } from '../src/shared/checkpoint'

describe('CHECKPOINT_PROMPT', () => {
  it('is a single line so the agent TUI submits it as one message', () => {
    // Broadcast writes straight to the PTY; a newline would read as Enter and
    // submit the prompt early, splitting one instruction into several.
    expect(CHECKPOINT_PROMPT).not.toMatch(/[\r\n]/)
  })

  it('tells the agent to commit but never push (safe, offline park)', () => {
    const lower = CHECKPOINT_PROMPT.toLowerCase()
    expect(lower).toContain('commit')
    expect(lower).toContain('do not push')
  })

  it('tells the agent to stop and wait afterwards (goes idle, ready to reboot)', () => {
    expect(CHECKPOINT_PROMPT.toLowerCase()).toContain('wait')
  })
})
