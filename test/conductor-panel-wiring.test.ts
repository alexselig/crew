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
  flattenPropertyAccess,
  findCallbackDependencies,
  findCallbackVariable,
  findCallsTo,
  findDirectCallsTo,
  findEffectCalls,
  findEffectDependencies,
  findHookCall,
  findJsxTags,
  findTryStatement,
  hasDirectAssignment,
  firstStatementAssigns,
  findIdentifiers,
  findUseStateDeclaration,
  findDeclarationsOf,
  findAssignmentsTo,
  isWithin,
  enclosingIfStatement,
  hasStrictEqualityOperand,
  logicalAndOperands,
  resolveAwaitedCall,
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
    const calls = findDirectCallsTo(tryStatement.tryBlock, 'window.crew.publishLane')
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
    const calls = findDirectCallsTo(tryStatement.tryBlock, 'window.crew.syncLane')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === 'workspaceId' && c.arguments[1]?.getText() === 'laneId'
    )).toBe(true)
  })

  it('wraps publish in a real try/catch, calling describeUnexpectedFailure in the catch block', () => {
    const { tryStatement } = handlerParts('publish')
    expect(tryStatement.catchClause).toBeDefined()
    expect(tryStatement.catchClause!.variableDeclaration?.name.getText()).toBe('error')
    const calls = findDirectCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'publish'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
  })

  it('wraps sync in a real try/catch, calling describeUnexpectedFailure in the catch block', () => {
    const { tryStatement } = handlerParts('sync')
    expect(tryStatement.catchClause).toBeDefined()
    expect(tryStatement.catchClause!.variableDeclaration?.name.getText()).toBe('error')
    const calls = findDirectCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'sync'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
  })

  it('refreshes the snapshot from a real refresh() call inside a finally block, on every handler', () => {
    // Load-bearing against the actual bug this bullet targets: without this,
    // a rejection that happens after the backend already broadcast
    // `publishing: laneId` (but before any broadcast clears it) leaves the
    // panel trusting that stale lock forever — the try/catch alone only
    // stops the rejection from being unhandled, it does not un-stick the UI.
    for (const name of ['publish', 'sync', 'recheck', 'acknowledge']) {
      const { tryStatement } = handlerParts(name)
      expect(tryStatement.finallyBlock, `${name} has no finally block`).toBeDefined()
      expect(
        findDirectCallsTo(tryStatement.finallyBlock!, 'refresh'),
        `${name}'s finally block does not call refresh()`
      ).not.toHaveLength(0)
    }
  })

  // Re-review finding I-4: a publish that runs tests takes minutes, so the
  // user may well have switched workspaces by the time its `finally` runs.
  // The refresh must therefore drop a snapshot fetched for a workspace this
  // panel is no longer showing — otherwise workspace A's lanes render under
  // B, and B's buttons send B's workspace id with A's lane ids ("unknown
  // lane").
  it('drops a refreshed snapshot fetched for a workspace the panel no longer shows', () => {
    const refresh = findCallbackVariable(source, 'refresh')
    expect(refresh, 'no refresh handler found').toBeDefined()

    // It fetches THIS panel's workspace…
    const stateCalls = findDirectCallsTo(refresh!.body, 'window.crew.getConductorState')
    expect(stateCalls.some((c) => c.arguments[0]?.getText() === 'workspaceId')).toBe(true)

    // …and every setSnapshot it performs is guarded by a real comparison of
    // the ref holding the currently-shown workspace against the workspace
    // this call was made for. Asserting on the enclosing `if` — not merely
    // that a `===` appears somewhere in the handler — is what makes this
    // load-bearing: a comparison computed and thrown away would satisfy the
    // weaker check while leaving the stale snapshot on screen.
    const sets = findDirectCallsTo(refresh!.body, 'setSnapshot')
    expect(sets).not.toHaveLength(0)
    for (const set of sets) {
      const guard = enclosingIfStatement(set)
      expect(guard, 'setSnapshot in refresh() is not inside an if statement').toBeDefined()
      const operands = logicalAndOperands(guard!.expression)
      expect(
        hasStrictEqualityOperand(operands, 'shownWorkspace.current', 'workspaceId'),
        'refresh() does not compare the shown workspace against the one it fetched'
      ).toBe(true)
    }
  })

  // Wave 3 finding 1: the test above pins the GUARD, but the guard is only
  // as good as the ref it reads. With `shownWorkspace.current = workspaceId`
  // deleted the ref stays pinned to the first workspace forever, so a late
  // refresh for A is drawn under B and B's own refresh is dropped — the very
  // bug I-4 exists to fix — and every other assertion in this file still
  // passed. This pins the update itself: a real `useRef` declaration, and a
  // real assignment statement executed by the effect that fires on a
  // workspace change (not by some nested callback it merely defines).
  it('re-points the shown-workspace ref at the new workspace whenever the workspace changes', () => {
    const ref = findHookCall(source, 'shownWorkspace', 'useRef')
    expect(ref, 'shownWorkspace is not declared from a real useRef() call').toBeDefined()
    expect(ref!.arguments[0]?.getText()).toBe('workspaceId')

    const effects = findEffectCalls(source).filter((call) => {
      const deps = call.arguments[1]
      return deps !== undefined && ts.isArrayLiteralExpression(deps) &&
        deps.elements.some((el) => el.getText() === 'workspaceId')
    })
    expect(effects, 'no useEffect depends on workspaceId').not.toHaveLength(0)
    const updating = effects.filter((call) => {
      const body = call.arguments[0]
      return body !== undefined && hasDirectAssignment(body, 'shownWorkspace.current', 'workspaceId')
    })
    expect(
      updating,
      'no [workspaceId] effect assigns shownWorkspace.current = workspaceId, so the ref never follows the panel'
    ).toHaveLength(1)

    // Wave 4 finding F-3: "assigns it somewhere" is not enough. An early
    // return ahead of the assignment — `if (workspaceId === null) return` is
    // an ordinary refactor, not a contrived trick — leaves the ref pointing
    // at the previous workspace while every other assertion here still
    // passes. The ref exists to record which workspace is on screen, so it
    // must be recorded before any code can decide not to.
    expect(
      firstStatementAssigns(updating[0].arguments[0]!, 'shownWorkspace.current', 'workspaceId'),
      'the [workspaceId] effect does something before re-pointing shownWorkspace.current, so an early return can skip it'
    ).toBe(true)
  })

  // Wave 3 finding 2: the same drop rule, applied to the MESSAGE. A publish
  // on A that finishes after a switch must not announce "Published…" or
  // "tests failed" in B's panel. Asserting both halves — that no handler
  // calls setMessage directly, and that the one reporter they do call
  // guards setMessage with the real comparison — is what makes this
  // load-bearing: removing the guard fails, and so does routing around it.
  it('drops a result message belonging to a workspace the panel no longer shows', () => {
    const report = findCallbackVariable(source, 'report')
    expect(report, 'no report handler found').toBeDefined()
    const parameter = report!.parameters[0]?.name.getText()
    expect(parameter, 'report takes no message parameter').toBeDefined()

    const sets = findDirectCallsTo(report!.body, 'setMessage')
    expect(sets, 'report() does not call setMessage').not.toHaveLength(0)
    for (const set of sets) {
      expect(set.arguments[0]?.getText(), 'report() sets a message other than the one it was given').toBe(parameter)
      const guard = enclosingIfStatement(set)
      expect(guard, 'setMessage in report() is not inside an if statement').toBeDefined()
      const operands = logicalAndOperands(guard!.expression)
      expect(
        hasStrictEqualityOperand(operands, 'shownWorkspace.current', 'workspaceId'),
        'report() does not compare the shown workspace against the one the result belongs to'
      ).toBe(true)
    }

    for (const name of ['publish', 'sync', 'recheck', 'acknowledge']) {
      const handler = findCallbackVariable(source, name)
      expect(handler, `no ${name} handler found`).toBeDefined()
      expect(
        findDirectCallsTo(handler!.body, 'setMessage'),
        `${name} calls setMessage directly, bypassing the workspace guard`
      ).toHaveLength(0)
      expect(
        findDirectCallsTo(handler!.body, 'report'),
        `${name} never reports its result`
      ).not.toHaveLength(0)
    }

    // Wave 4 finding F-3: "no handler CALLS setMessage" is routed around by
    // `promise.then(setMessage)` (a reference, not a call) or by an alias
    // (`const say = setMessage`) — both put an unguarded message on screen
    // for a workspace the panel may no longer show. The setter is therefore
    // confined to the two places entitled to it: its own useState binding
    // and the guarded reporter. The effect may reach it too, since the
    // effect is what clears the message on a workspace change.
    const declaration = findUseStateDeclaration(source, 'setMessage')
    expect(declaration, 'setMessage is not bound by a real useState() call').toBeDefined()
    const allowed: ts.Node[] = [declaration!.name, report!, ...findEffectCalls(source).map((call) => call.arguments[0]!)]
    const stray = findIdentifiers(source, 'setMessage').filter(
      (id) => !allowed.some((node) => isWithin(id, node))
    )
    expect(
      stray.map((id) => id.parent.getText()),
      'setMessage is mentioned outside report() and the workspace effect — an alias or a .then(setMessage) bypasses the workspace guard'
    ).toHaveLength(0)
  })

  // Wave 3 finding 4 (second half): every assertion in this file that names
  // `workspaceId` assumes it still means the prop. Reassigning or shadowing
  // it inside a handler would satisfy all of them while the handler acted on
  // some other workspace entirely.
  it('never reassigns or shadows the workspaceId prop', () => {
    const assignments = findAll(source, ts.isBinaryExpression).filter((expr) =>
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken && expr.left.getText() === 'workspaceId')
    expect(assignments, 'workspaceId is reassigned').toHaveLength(0)
    const shadowParams = findAll(source, ts.isParameter).filter(
      (p) => ts.isIdentifier(p.name) && p.name.text === 'workspaceId')
    expect(shadowParams, 'workspaceId is shadowed by a parameter').toHaveLength(0)
    const shadowVars = findAll(source, ts.isVariableDeclaration).filter(
      (d) => ts.isIdentifier(d.name) && d.name.text === 'workspaceId')
    expect(shadowVars, 'workspaceId is shadowed by a local declaration').toHaveLength(0)
  })

  // Wave 4 finding F-3: the same reasoning, applied to `outcome`. The
  // acknowledge assertion below follows the dataflow from
  // describeAcknowledgeOutcome back to the real IPC call through a variable
  // named `outcome`; a second `outcome` declared in an inner block, or a
  // `let outcome` reassigned after the await, makes that trace describe a
  // different value than the one the call returned — the panel would then
  // report an acknowledgement or a sync that never happened.
  it('never shadows or reassigns the outcome a handler awaited', () => {
    for (const name of ['sync', 'acknowledge']) {
      const handler = findCallbackVariable(source, name)
      expect(handler, `no ${name} handler found`).toBeDefined()
      const declared = findDeclarationsOf(handler!, 'outcome')
      expect(
        declared.map((d) => d.declaration.getText()),
        `${name} declares outcome more than once, so an inner shadow can stand in for the awaited result`
      ).toHaveLength(1)
      expect(declared[0].isConst, `${name} declares outcome with let/var, so it can be reassigned after the await`).toBe(true)
      expect(
        findAssignmentsTo(handler!, 'outcome').map((a) => a.getText()),
        `${name} reassigns outcome after awaiting it`
      ).toHaveLength(0)
      const shadowParams = findAll(handler!, ts.isParameter).filter(
        (p) => ts.isIdentifier(p.name) && p.name.text === 'outcome')
      expect(shadowParams, `${name} shadows outcome with a parameter`).toHaveLength(0)
    }
  })

  // Re-review finding I-3: with `[workspaceId]` emptied in every hook, all
  // of this file's other assertions still passed while publish, sync and
  // Re-check silently kept acting on the workspace the panel FIRST showed.
  // A deps array is part of the wiring, not a formality.
  it('re-creates every conductor hook when the workspace changes', () => {
    for (const name of ['refresh', 'report', 'publish', 'sync', 'recheck', 'acknowledge']) {
      const deps = findCallbackDependencies(source, name)
      expect(deps, `${name} is not a useCallback with a dependency array`).toBeDefined()
      expect(deps, `${name} does not depend on workspaceId`).toContain('workspaceId')
    }
    // The subscribe/fetch effect is the same story: stale deps there leave
    // the panel subscribed for, and rendering, the previous workspace.
    const effectDeps = findEffectDependencies(source)
    expect(effectDeps).not.toHaveLength(0)
    for (const deps of effectDeps) {
      expect(deps, 'a useEffect has no dependency array').toBeDefined()
      expect(deps, 'a useEffect does not depend on workspaceId').toContain('workspaceId')
    }
  })

  // Review finding 7: publish and sync refuse while an interrupted
  // operation is outstanding, and only a reconcile clears that. Without a
  // control that runs one, a single crashed publish left the workspace
  // read-only until the app was restarted.
  it('runs a real window.crew.reconcileConductor(workspaceId) call from the recheck handler, inside its try block', () => {
    const { tryStatement } = handlerParts('recheck')
    const calls = findDirectCallsTo(tryStatement.tryBlock, 'window.crew.reconcileConductor')
    expect(calls.some((c) => c.arguments[0]?.getText() === 'workspaceId')).toBe(true)
    // Re-review m-5: describeReconcileReport must be handed THIS reconcile's
    // result, not merely called somewhere nearby — a version that described
    // some other value (or a literal) would report a reconcile that never
    // happened while satisfying a bare "is it called?" check.
    const described = findDirectCallsTo(tryStatement.tryBlock, 'describeReconcileReport')
    expect(described).toHaveLength(1)
    const argument = described[0].arguments[0]
    expect(argument, 'describeReconcileReport was called with no argument').toBeDefined()
    expect(ts.isAwaitExpression(argument!), 'describeReconcileReport is not given an awaited value').toBe(true)
    const awaited = (argument as ts.AwaitExpression).expression
    expect(ts.isCallExpression(awaited)).toBe(true)
    expect(calls).toContain(awaited as ts.CallExpression)
  })

  it('guards recheck with a real try/catch/finally like publish and sync', () => {
    const { tryStatement } = handlerParts('recheck')
    expect(tryStatement.catchClause).toBeDefined()
    const calls = findDirectCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(calls.some((c) =>
      c.arguments[0]?.getText() === "'recheck'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
    expect(tryStatement.finallyBlock).toBeDefined()
    expect(findDirectCallsTo(tryStatement.finallyBlock!, 'refresh')).not.toHaveLength(0)
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
    // Re-review finding I-3: the previous version of this test checked only
    // that a `===` comparison appeared somewhere in the handler and that
    // setSnapshot(event.state) appeared somewhere too — so turning the
    // guard's `&&` into `||` (accepting EVERY other workspace's broadcast)
    // left it green. What has to hold is that the accepting call is
    // GUARDED by that comparison.
    const subscriptions = findCallsTo(source, 'window.crew.onConductorState')
    expect(subscriptions).toHaveLength(1)
    const handler = subscriptions[0].arguments[0]
    expect(handler).toBeDefined()

    const sets = findAll(handler!, ts.isCallExpression).filter(
      (call) => flattenPropertyAccess(call.expression) === 'setSnapshot'
    )
    expect(sets).toHaveLength(1)
    expect(sets[0].arguments[0]?.getText()).toBe('event.state')

    const guard = enclosingIfStatement(sets[0])
    expect(guard, 'the broadcast setSnapshot is not inside an if statement').toBeDefined()
    const operands = logicalAndOperands(guard!.expression)
    // A `||` guard flattens to a single operand (the whole `a || b`), which
    // carries no `===` comparison of its own — so this fails for it, which
    // is the entire point.
    expect(
      hasStrictEqualityOperand(operands, 'event.workspaceId', 'workspaceId'),
      'the broadcast guard does not AND in a comparison of the event workspace against this panel\'s'
    ).toBe(true)
  })

  // Re-review finding I-1: reconcile can only REPORT an interrupted
  // operation. Acknowledging is what closes it on the record and reopens
  // publish and sync, so the control must exist, reach the real IPC call,
  // and name both the workspace and the operation it is closing.
  it('runs a real window.crew.acknowledgeConductorOperation(workspaceId, opId, detail) call from the acknowledge handler', () => {
    const { tryStatement } = handlerParts('acknowledge')
    const calls = findDirectCallsTo(tryStatement.tryBlock, 'window.crew.acknowledgeConductorOperation')
    expect(calls).toHaveLength(1)
    expect(calls[0].arguments[0]?.getText()).toBe('workspaceId')
    expect(calls[0].arguments[1]?.getText()).toBe('opId')
    expect(calls[0].arguments[2]).toBeDefined()

    const described = findDirectCallsTo(tryStatement.tryBlock, 'describeAcknowledgeOutcome')
    expect(described).toHaveLength(1)
    // …and it describes THIS acknowledge's outcome, not something else.
    // Wave 3 finding 4: checking only that the argument is spelled
    // `outcome` passed when the IPC call's result was thrown away and a
    // literal named `outcome` was described instead — the panel would then
    // report an acknowledgement that never happened. The argument must
    // carry the awaited result of the call asserted above, exactly as the
    // recheck assertion does for describeReconcileReport.
    const argument = described[0].arguments[0]
    expect(argument, 'describeAcknowledgeOutcome was called with no argument').toBeDefined()
    const awaited = resolveAwaitedCall(tryStatement.tryBlock, argument!)
    expect(awaited, 'describeAcknowledgeOutcome is not given an awaited call result').toBeDefined()
    expect(calls).toContain(awaited!)

    expect(tryStatement.catchClause).toBeDefined()
    const failures = findDirectCallsTo(tryStatement.catchClause!.block, 'describeUnexpectedFailure')
    expect(failures.some((c) =>
      c.arguments[0]?.getText() === "'acknowledge'" && c.arguments[1]?.getText() === 'error'
    )).toBe(true)
  })

  it('wires the acknowledge handler to a real rendered button, per operation', () => {
    const buttons = findJsxTags(source, 'button')
    const wired = buttons.filter((tag) => {
      const onClick = jsxAttributeValue(tag, 'onClick')
      return onClick !== undefined && findCallsTo(onClick, 'acknowledge').length > 0
    })
    expect(wired).toHaveLength(1)
    // The op being acknowledged is the one whose row the button sits in —
    // an acknowledge that named no operation could close one the user was
    // never shown.
    const onClick = jsxAttributeValue(wired[0], 'onClick')!
    const calls = findCallsTo(onClick, 'acknowledge')
    expect(calls[0].arguments[0]?.getText()).toBe('op.opId')
  })

  it('imports describeUnexpectedFailure via a real import declaration from the pure view-model, not a local copy', () => {
    expect(hasNamedImport(source, '../conductor-view-model', 'describeUnexpectedFailure')).toBe(true)
  })
})
