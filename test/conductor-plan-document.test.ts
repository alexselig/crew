import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPlanDocument } from '../src/renderer/conductor-plan-document'
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
})
