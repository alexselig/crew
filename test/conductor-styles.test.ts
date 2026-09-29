import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Finding 11: a blocked lane must not look identical to a working one, and
// the composer's classes must not be silently unstyled. Rather than
// trusting a hand-written list of class names (which drifts the moment a
// component changes), this test extracts every `conductor-*` class token
// actually referenced by the two components' source text -- including the
// two dynamic template-literal suffixes (`conductor-lane-${status}` and
// `conductor-composer-note--${severity}`), expanded against the real
// LaneStatus/severity union types -- and asserts styles.css has a selector
// for each one. No DOM/jsdom is used or needed: this is a pure source-text
// check, matching the convention in test/agent-ui-css.test.ts.

const read = (path: string) => readFileSync(resolve(path), 'utf8')


function extractUnionMembers(source: string, declaration: RegExp): string[] {
  const match = source.match(declaration)
  if (!match) throw new Error(`could not find declaration ${declaration} in source`)
  return Array.from(match[1].matchAll(/'([a-zA-Z0-9_-]+)'/g)).map((m) => m[1])
}

function extractStaticClassTokens(source: string): Set<string> {
  const tokens = new Set<string>()
  // Only scan inside className="..." / className={`...`} attribute values,
  // so import paths and comments containing "conductor-" are never mistaken
  // for class names.
  for (const attr of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const value = attr[1] ?? attr[2] ?? ''
    for (const m of value.matchAll(/conductor-[a-zA-Z0-9-]*/g)) {
      const token = m[0]
      if (token.endsWith('-')) continue // dynamic prefix, expanded separately
      tokens.add(token)
    }
  }
  return tokens
}

describe('conductor CSS coverage (Finding 11)', () => {
  it('has a styles.css rule for every conductor-* class used by ConductorComposer and ConductorPanel', () => {
    const composerSource = read('src/renderer/components/ConductorComposer.tsx')
    const panelSource = read('src/renderer/components/ConductorPanel.tsx')
    const css = read('src/renderer/styles.css')

    const laneStatuses = extractUnionMembers(read('src/shared/conductor.ts'), /type LaneStatus\s*=\s*([^\n]+)/)
    const severities = extractUnionMembers(read('src/shared/conductor-proposal.ts'), /severity:\s*([^\n]+)/)

    expect(laneStatuses).toEqual(expect.arrayContaining(['working', 'publishing', 'blocked', 'done']))
    expect(severities).toEqual(expect.arrayContaining(['blocking', 'warning']))

    const used = new Set<string>([
      ...extractStaticClassTokens(composerSource),
      ...extractStaticClassTokens(panelSource),
      ...laneStatuses.map((s) => `conductor-lane-${s}`),
      ...severities.map((s) => `conductor-composer-note--${s}`)
    ])

    expect(used.size).toBeGreaterThan(15)

    const missing = Array.from(used).filter((className) => {
      // A rule is any selector that starts the class name at a selector
      // boundary (. or start-of-compound) -- covers `.foo`, `.foo.bar`,
      // `.foo button`, `.foo:hover`, `.foo td` etc.
      const re = new RegExp(`\\.${className}(?![a-zA-Z0-9_-])`)
      return !re.test(css)
    })

    expect(missing).toEqual([])
  })
})
