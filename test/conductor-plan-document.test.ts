import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPlanDocument, planDialogAction } from '../src/renderer/conductor-plan-document'
import type { ReconciledRoster } from '../src/shared/conductor-proposal'

function roster(over: Partial<ReconciledRoster> = {}): ReconciledRoster {
  return {
    summary: 'Split the importer from the renderer.',
    narrative: [],
    rows: [
      {
        roleName: 'importer',
        kind: 'author',
        agent: { presetId: 'claude', model: 'opus' },
        rationale: 'Long refactor, needs the strongest model.'
      }
    ],
    notes: [],
    ...over
  }
}

describe('buildPlanDocument', () => {
  it('opens with the summary', () => {
    const doc = buildPlanDocument(roster())
    expect(doc.bands[0]).toEqual({
      kind: 'summary',
      heading: 'The plan',
      paragraphs: ['Split the importer from the renderer.']
    })
  })

  it('omits the summary band when there is no summary', () => {
    const doc = buildPlanDocument(roster({ summary: '   ' }))
    expect(doc.bands).toHaveLength(0)
  })

  it('keeps narrative sections in order after the summary', () => {
    const doc = buildPlanDocument(
      roster({
        narrative: [
          { heading: 'Approach', body: 'One lane per seam.' },
          { heading: 'Risks', body: 'The importer touches the schema.' }
        ]
      })
    )
    expect(doc.bands.map((b) => b.heading)).toEqual(['The plan', 'Approach', 'Risks'])
    expect(doc.bands[1].kind).toBe('section')
  })

  it('splits a body into paragraphs on blank lines', () => {
    const doc = buildPlanDocument(
      roster({ narrative: [{ heading: 'Approach', body: 'First.\n\n\nSecond.\n' }] })
    )
    expect(doc.bands[1].paragraphs).toEqual(['First.', 'Second.'])
  })

  it('treats markup in a body as literal text, never as structure', () => {
    const body = '<script>alert(1)</script> **not bold**'
    const doc = buildPlanDocument(roster({ narrative: [{ heading: 'h', body }] }))
    expect(doc.bands[1].paragraphs).toEqual([body])
  })

  it('labels a null model rather than inventing one', () => {
    const r = roster()
    r.rows[0].agent.model = null
    const doc = buildPlanDocument(r)
    expect(doc.rows[0].modelLabel).toBe('default model')
  })

  it('attaches a blocking note to its own row and refuses Create', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 0, severity: 'blocking', message: 'opus is not an available model — choose one' }] })
    )
    expect(doc.rows[0].problems).toEqual(['opus is not an available model — choose one'])
    expect(doc.blockingCount).toBe(1)
    expect(doc.canCreate).toBe(false)
  })

  it('lets warnings through — they inform, they do not block', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 0, severity: 'warning', message: 'no reviewer proposed' }] })
    )
    expect(doc.rows[0].warnings).toEqual(['no reviewer proposed'])
    expect(doc.canCreate).toBe(true)
  })

  it('collects roster-wide notes separately from row notes', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: -1, severity: 'warning', message: 'proposed 5 lanes; 3 were dropped' }] })
    )
    expect(doc.rosterNotes).toEqual(['proposed 5 lanes; 3 were dropped'])
    expect(doc.rows[0].warnings).toEqual([])
  })

  it('ignores a note pointing at a row that does not exist', () => {
    const doc = buildPlanDocument(
      roster({ notes: [{ row: 7, severity: 'blocking', message: 'stale' }] })
    )
    expect(doc.rows[0].problems).toEqual([])
    expect(doc.canCreate).toBe(true)
  })

  it('never hands agent text to the DOM as markup', () => {
    const source = readFileSync('src/renderer/components/ConductorPlanDialog.tsx', 'utf8')
    expect(source).not.toContain('dangerouslySetInnerHTML')
  })

  it('cannot return before rendering the plan document — the document is never conditional', () => {
    // The regression this guards against: an early return (e.g. "if
    // (continuing) return <ConductorComposer .../>") that swaps out the
    // whole component, losing doc.bands/doc.rows instead of merely swapping
    // the action-bar/composer region beneath them. The component body must
    // contain exactly one `return` — the single one that renders the plan
    // document unconditionally, with only the trailing region varying.
    const source = readFileSync('src/renderer/components/ConductorPlanDialog.tsx', 'utf8')
    const body = source.slice(source.indexOf('export function ConductorPlanDialog'))
    const returns = body.match(/\breturn\b/g) ?? []
    expect(returns).toHaveLength(1)
  })

  it('never disables Continue for a blocked proposal — the composer is where blocking notes get fixed', () => {
    const blocked = buildPlanDocument(
      roster({ notes: [{ row: 0, severity: 'blocking', message: 'stale preset' }] })
    )
    expect(blocked.canCreate).toBe(false)
    // The pure action carries no disabled-ness at all — opening the composer
    // is never gated on canCreate/blockingCount. Creation itself is still
    // gated, but by validateRoster inside the composer's own submit, not here.
    expect(planDialogAction()).toEqual({ label: 'Continue' })
    const source = readFileSync('src/renderer/components/ConductorPlanDialog.tsx', 'utf8')
    expect(source).not.toMatch(/disabled=/)
  })

  it('never labels the sole action "Create" — it opens the composer, it does not create a run', () => {
    expect(planDialogAction().label).not.toMatch(/create/i)
  })

  it('has no second action duplicating the first under a different label', () => {
    // Finding 1's regression was two buttons — "Edit the roster" and
    // "Create" — both wired to the same setEditing(true) handoff. Guard the
    // source directly: there must be exactly one handler that opens the
    // composer, and no leftover "Edit the roster" label.
    const source = readFileSync('src/renderer/components/ConductorPlanDialog.tsx', 'utf8')
    expect(source).not.toContain('Edit the roster')
    const opensComposer = source.match(/onClick=\{.*setContinuing\(true\).*\}/g) ?? []
    expect(opensComposer).toHaveLength(1)
  })
})
