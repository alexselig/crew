import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { findAll, parseSource } from './helpers/ts-ast'

// Re-review "also fix" m-4: parseSource's whole reason to exist is that a
// file which fails to parse still yields a partial tree, so every
// findAll-based assertion over it passes VACUOUSLY — nothing found reads as
// "no violation". That guard had a comment but no test, so a refactor that
// dropped the diagnostics check (or restored a `?? []` fallback) would have
// silently turned every AST suite on this branch into a no-op while staying
// green. These tests fail if the throw goes away.
describe('parseSource diagnostics guard', () => {
  let dir: string | undefined

  const fixture = (name: string, text: string): string => {
    // Scratch lives under the repo, never /tmp, and is removed after each test.
    dir ??= mkdtempSync(join('test', 'ts-ast-fixture-'))
    const path = join(dir, name)
    writeFileSync(path, text, 'utf8')
    return path
  }

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('parses a syntactically valid file', () => {
    const path = fixture('good.tsx', 'export const answer = () => 42\n')
    const source = parseSource(path)
    expect(findAll(source, ts.isArrowFunction)).toHaveLength(1)
  })

  it('throws on a syntactically broken file instead of returning a partial tree', () => {
    const path = fixture('broken.tsx', 'export const broken = () => {\n  const x = (\n')
    expect(() => parseSource(path)).toThrow(/syntactic errors/)
  })

  it('names the offending file, so the failure is actionable', () => {
    const path = fixture('named.tsx', 'function half( {\n')
    expect(() => parseSource(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  // The exact vacuous pass this guard prevents: the broken file above does
  // still yield a tree, and an assertion over it would have found nothing —
  // which is indistinguishable from a clean file.
  it('would otherwise have handed back a tree missing the very nodes assertions look for', () => {
    const text = 'export const publish = async ( => {\n  await window.crew.publishLane(workspaceId, laneId)\n}\n'
    const partial = ts.createSourceFile('partial.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    // The handler this file's real suites assert on simply is not in the
    // recovered tree, so "is publish a useCallback with the right deps?"
    // would have answered "nothing to see here" rather than failing.
    expect(findAll(partial, ts.isArrowFunction)).toHaveLength(0)
  })
})
