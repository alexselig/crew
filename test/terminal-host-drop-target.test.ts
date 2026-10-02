/**
 * TerminalHost used to unmount the whole terminal subtree whenever no Crew
 * window was focused, as a background-cost saving. That subtree owns the
 * session's file-drop target, and dragging a file out of Finder *requires*
 * Crew to be unfocused - so the drop target was guaranteed to be absent at the
 * moment the drop landed, and file drops could never work. Resuming also
 * replays the buffer from a snapshot, which loses the scroll position.
 *
 * The cost saving now lives in the pools, which release *unmounted* terminals
 * only; `legacy-terminal-suspension` and `terminal-pool-bounded` cover that
 * behaviourally. What is left to pin here is the host itself, and it is pinned
 * against the source: the node test project does not enable `--jsx`, so this
 * file deliberately does not import the component.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  new URL('../src/renderer/components/TerminalHost.tsx', import.meta.url),
  'utf8'
)

describe('TerminalHost', () => {
  it('does not gate the terminal on whether a Crew window is focused', () => {
    expect(SOURCE).not.toMatch(/useAppActivity/)
    expect(SOURCE).not.toMatch(/from '\.\.\/app-activity'/)
  })

  it('has no inert placeholder to substitute for the drop target', () => {
    expect(SOURCE).not.toMatch(/term-mount--suspended/)
    expect(SOURCE).not.toMatch(/aria-hidden/)
  })

  it('still renders exactly one of the two terminal implementations', () => {
    expect(SOURCE).toMatch(/<CrewTerminal\b/)
    expect(SOURCE).toMatch(/<TerminalView\b/)
  })
})
