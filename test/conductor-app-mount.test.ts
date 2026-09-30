// App.tsx renders no DOM under vitest's `environment: 'node'` config, so this
// coverage — like conductor-plan-document.test.ts's own security scan — reads
// the compiled source text directly and pins the invariants a revert would
// actually break: the two components are imported AND rendered (not merely
// imported, or defined-but-dead), each behind the state variable that opens
// it, and the compose handoff reaches the real IPC call.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/renderer/App.tsx', 'utf8')

describe('App.tsx — mounting the composer and plan dialog', () => {
  it('imports both components (review finding 12: today nothing renders either)', () => {
    expect(source).toMatch(/import\s*\{\s*ConductorComposer\s*\}\s*from\s*'\.\/components\/ConductorComposer'/)
    expect(source).toMatch(/import\s*\{\s*ConductorPlanDialog\s*\}\s*from\s*'\.\/components\/ConductorPlanDialog'/)
  })

  it('renders ConductorComposer behind the state flag that opens it, not merely importing it', () => {
    const flagIndex = source.indexOf('showConductorComposer &&')
    const tagIndex = source.indexOf('<ConductorComposer', flagIndex)
    expect(flagIndex).toBeGreaterThan(-1)
    expect(tagIndex).toBeGreaterThan(flagIndex)
    // Load-bearing against "imported but rendered nowhere": the tag must
    // appear textually inside the conditional block, which we pin by
    // requiring the tag to occur before the next top-level sibling block
    // opens (a loose upper bound — the closing '</div>' of the overlay).
    expect(tagIndex).toBeLessThan(source.indexOf('</div>', tagIndex))
  })

  it('renders ConductorPlanDialog behind the loaded-plan state, not merely importing it', () => {
    const flagIndex = source.indexOf('conductorPlan &&')
    const tagIndex = source.indexOf('<ConductorPlanDialog', flagIndex)
    expect(flagIndex).toBeGreaterThan(-1)
    expect(tagIndex).toBeGreaterThan(flagIndex)
    expect(tagIndex).toBeLessThan(source.indexOf('</div>', tagIndex))
  })

  it('wires ConductorComposer\'s onCompose to the real IPC call, not a stub', () => {
    const fnIndex = source.indexOf('const composeConductedWorkspace')
    expect(fnIndex).toBeGreaterThan(-1)
    const fnBody = source.slice(fnIndex, source.indexOf('\n\n', fnIndex))
    expect(fnBody).toContain('window.crew.composeConductedWorkspace(draft)')
  })

  it('passes composeConductedWorkspace as onCompose to both mount points', () => {
    const opens = source.match(/onCompose=\{composeConductedWorkspace\}/g) ?? []
    expect(opens).toHaveLength(2)
  })

  it('gives ConductorPanel the callbacks that open each entry point, rather than mounting it bare', () => {
    const tagIndex = source.indexOf('<ConductorPanel')
    const closeIndex = source.indexOf('/>', tagIndex)
    expect(tagIndex).toBeGreaterThan(-1)
    const tag = source.slice(tagIndex, closeIndex)
    expect(tag).toMatch(/onNewWorkspace=\{.*setShowConductorComposer\(true\).*\}/)
    expect(tag).toMatch(/onLoadPlan=\{.*loadConductorPlanFile.*\}/)
  })

  it('closes the composer/plan dialog only once composeConductedWorkspace actually succeeds', () => {
    // Regression this guards against: closing on every call regardless of
    // ComposeResult, which would hide a failed compose (including the
    // survivingLanes arm) instead of leaving the dialog open to show it.
    const fnIndex = source.indexOf('const composeConductedWorkspace')
    const fnBody = source.slice(fnIndex, source.indexOf('return result', fnIndex))
    expect(fnBody).toMatch(/if\s*\(result\.ok\)\s*\{/)
    expect(fnBody).toContain('setShowConductorComposer(false)')
    expect(fnBody).toContain('setConductorPlan(null)')
  })
})
