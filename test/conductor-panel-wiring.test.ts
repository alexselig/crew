// ConductorPanel.tsx is a React component; under vitest's node-only config
// there is no DOM to mount it in. Its pure decision logic already lives in
// conductor-view-model.ts (conductorPanelMode/describeUnexpectedFailure,
// covered directly in conductor-view-model.test.ts). What is left to pin
// here is the WIRING itself — that publish/sync actually reach those pure
// functions inside a try/catch, and that a rejection always re-fetches the
// real snapshot in a `finally` so a stale "publishing" lock can never
// outlive the promise that set it.
//
// Task 7 fix round 1, Finding 2: the previous version of this file used
// plain substring scans (`source.indexOf(...)`), which still pass when the
// wiring is deleted and replaced by a comment or string literal with the
// same text. This version walks the real TypeScript AST so each assertion
// requires an actual TryStatement/CatchClause/CallExpression to exist.
import * as ts from 'typescript'
import { describe, it, expect } from 'vitest'
import {
  parseSource,
  hasNamedImport,
  findAll,
  findCallbackVariable,
  findCallsTo,
  findJsxTags,
  findThenCalls,
  findTryStatement,
  jsxAttributeValue
} from './helpers/ts-ast'

const source = parseSource('src/renderer/components/ConductorPanel.tsx')

function handlerParts(name: string): { body: ts.ConciseBody; tryStatement: ts.TryStatement } {
  const handler = findCallbackVariable(source, name)
  expect(handler).toBeDefined()
  const body = handler!.body
  const tryStatement = findTryStatement(body)
  expect(tryStatement).toBeDefined()
  return { body, tryStatement: tryStatement! }
}

describe('ConductorPanel — publish/sync never leave an unhandled rejection', () => {
  it('calls the real window.crew.publishLane(workspaceId, laneId) inside the try block, not outside the guard', () => {
    // Load-bearing against the exact regression Task 7 fixed: a dummy
    // try/catch/finally with the real IPC call moved outside it would
    // satisfy every other assertion here while resurrecting the unhandled
    // rejection this task exists to prevent.
    const { tryStatement } = handlerParts('publish')
    const calls = findCallsTo(tryStatement.tryBlock, 'window.crew.publishLane')
    // Review finding 1: the workspace is named by the CALL. A publish that
    // named only the lane depended on main having guessed the right
    // workspace, which it could not — the panel's workspace is a per-window
    // view preference main never sees change.
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === 'workspaceId' && c.arguments[1]?.getText() === 'laneId'
    )).toBe(true)
  })

  it('calls the real window.crew.syncLane(workspaceId, laneId) inside the try block, not outside the guard', () => {
    const { tryStatement } = handlerParts('sync')
    const calls = findCallsTo(tryStatement.tryBlock, 'window.crew.syncLane')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === 'workspaceId' && c.arguments[1]?.getText() === 'laneId'
    )).toBe(true)
  })

  it('wraps publish in a real try/catch, calling describeUnexpectedFailure in the catch block', () => {
    const { tryStatement } = handlerParts('publish')
    expect(tryStatement.catchClause).toBeDefined()
    expect(tryStatement.catchClause!.variableDeclaration?.name.getText()).toBe('error')
    const calls = findCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'publish'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
  })

  it('wraps sync in a real try/catch, calling describeUnexpectedFailure in the catch block', () => {
    const { tryStatement } = handlerParts('sync')
    expect(tryStatement.catchClause).toBeDefined()
    expect(tryStatement.catchClause!.variableDeclaration?.name.getText()).toBe('error')
    const calls = findCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'sync'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
  })

  it('refreshes the snapshot from a real getConductorState().then(setSnapshot) call inside a finally block, on both handlers', () => {
    // Load-bearing against the actual bug this bullet targets: without this,
    // a rejection that happens after the backend already broadcast
    // `publishing: laneId` (but before any broadcast clears it) leaves the
    // panel trusting that stale lock forever — the try/catch alone only
    // stops the rejection from being unhandled, it does not un-stick the UI.
    for (const name of ['publish', 'sync']) {
      const { tryStatement } = handlerParts(name)
      expect(tryStatement.finallyBlock).toBeDefined()
      const refreshCalls = findThenCalls(tryStatement.finallyBlock!, 'window.crew.getConductorState')
      expect(refreshCalls.some((c) => c.arguments[0]?.getText() === 'setSnapshot')).toBe(true)
      // …and re-fetches THIS panel's workspace, not whatever main last saw.
      const stateCalls = findCallsTo(tryStatement.finallyBlock!, 'window.crew.getConductorState')
      expect(stateCalls.some((c) => c.arguments[0]?.getText() === 'workspaceId')).toBe(true)
    }
  })

  // Review finding 7: publish and sync refuse while an interrupted
  // operation is outstanding, and only a reconcile clears that. Without a
  // control that runs one, a single crashed publish left the workspace
  // read-only until the app was restarted.
  it('runs a real window.crew.reconcileConductor(workspaceId) call from the recheck handler, inside its try block', () => {
    const { tryStatement } = handlerParts('recheck')
    const calls = findCallsTo(tryStatement.tryBlock, 'window.crew.reconcileConductor')
    expect(calls.some((c) => c.arguments[0]?.getText() === 'workspaceId')).toBe(true)
    const described = findCallsTo(tryStatement.tryBlock, 'describeReconcileReport')
    expect(described).toHaveLength(1)
  })

  it('guards recheck with a real try/catch/finally like publish and sync', () => {
    const { tryStatement } = handlerParts('recheck')
    expect(tryStatement.catchClause).toBeDefined()
    const calls = findCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'recheck'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
    expect(tryStatement.finallyBlock).toBeDefined()
    const refreshCalls = findThenCalls(tryStatement.finallyBlock!, 'window.crew.getConductorState')
    expect(refreshCalls.some((c) => c.arguments[0]?.getText() === 'setSnapshot')).toBe(true)
  })

  // The Re-check control has to be reachable, not merely defined: a handler
  // no button calls is the same read-only dead end as having no handler.
  it('wires the recheck handler to a real rendered button', () => {
    const buttons = findJsxTags(source, 'button')
    const wired = buttons.filter((tag) => {
      const onClick = jsxAttributeValue(tag, 'onClick')
      return onClick !== undefined && findCallsTo(onClick, 'recheck').length > 0
    })
    expect(wired).toHaveLength(1)
  })

  // Broadcasts are not addressed to a window, so each names the workspace
  // it describes and this panel must ignore every other workspace's.
  it('ignores a conductor state broadcast for a different workspace', () => {
    const subscriptions = findCallsTo(source, 'window.crew.onConductorState')
    expect(subscriptions).toHaveLength(1)
    const handler = subscriptions[0].arguments[0]
    expect(handler).toBeDefined()
    const comparisons = findAll(handler!, ts.isBinaryExpression).filter((b) =>
      b.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      b.left.getText() === 'event.workspaceId' &&
      b.right.getText() === 'workspaceId'
    )
    expect(comparisons).toHaveLength(1)
    // …and the snapshot it does accept is the event's state, not the event.
    const sets = findCallsTo(handler!, 'setSnapshot')
    expect(sets.some((c) => c.arguments[0]?.getText() === 'event.state')).toBe(true)
  })

  it('imports describeUnexpectedFailure via a real import declaration from the pure view-model, not a local copy', () => {
    expect(hasNamedImport(source, '../conductor-view-model', 'describeUnexpectedFailure')).toBe(true)
  })
})
