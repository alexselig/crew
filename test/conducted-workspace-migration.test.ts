import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import {
  parseSource,
  hasNamedImport,
  findAll,
  findCallsTo,
  findDeclarationsOf,
  enclosingIfStatement,
  isWithin
} from './helpers/ts-ast'

const STORE = 'src/main/store.ts'
const ID = '2026-09-conducted-workspace-flag'

function migrationEntry(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  return findAll(source, ts.isObjectLiteralExpression).find((o) =>
    o.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        p.name.getText() === 'id' &&
        ts.isStringLiteral(p.initializer) &&
        p.initializer.text === ID
    )
  )
}

describe('restoring the conducted flag on workspaces conducted before it existed', () => {
  const source = parseSource(STORE)

  it('runs as a store migration, so the flag is set before anything reads the workspace list', () => {
    const entry = migrationEntry(source)
    expect(entry).toBeDefined()
    const migrations = findDeclarationsOf(source, 'MIGRATIONS')[0]
    expect(migrations).toBeDefined()
    expect(isWithin(entry!, migrations.declaration)).toBe(true)
  })

  it('decides from the persisted conductor configs, not from a guess', () => {
    expect(hasNamedImport(source, 'shared/workspaces', 'markConductedWorkspaces')).toBe(true)
    const entry = migrationEntry(source)!
    const calls = findCallsTo(entry, 'markConductedWorkspaces')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments).toHaveLength(2)
    expect(calls[0].arguments[0].getText()).toContain('workspaces')
    expect(calls[0].arguments[1].getText()).toContain('conductorConfigs')
  })

  it('writes the workspace list back only when something actually changed', () => {
    const entry = migrationEntry(source)!
    const writes = findAll(entry, ts.isBinaryExpression).filter(
      (b) =>
        b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        b.left.getText().replace(/\s/g, '') === 'd.workspaces'
    )
    expect(writes).toHaveLength(1)
    const guard = enclosingIfStatement(writes[0])
    expect(guard).toBeDefined()
    expect(guard!.expression.getText()).toContain('changed')
  })
})
