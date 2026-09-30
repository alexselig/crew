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
  findRefUses,
  findWritesTo,
  isUnconditionalLeadingStatement,
  isWithin,
  enclosingIfStatement,
  hasStrictEqualityOperand,
  logicalAndOperands,
  resolveAwaitedCall,
  duplicateBoundKeys,
  valueVariesWith,
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

/** Wave 6, F-9 (F5) and wave 7, F-9 (X1, X2, X6): a handler calling the
 *  real IPC and a handler REPORTING what it returned are two different
 *  claims. The message must be computed from the value the call handed
 *  back, and — the wave-7 half — computed in a way the value can actually
 *  change: `outcome.ok ? 'Lane synced' : 'Lane synced'` and `outcome &&
 *  'Lane synced'` both name the outcome while announcing success for a sync
 *  that conflicted. */
function expectReportsWhatItReceived(handlerName: string, ipc: string): void {
  const { tryStatement } = handlerParts(handlerName)
  const reports = findDirectCallsTo(tryStatement.tryBlock, 'report')
  expect(reports, `${handlerName} does not report exactly once from its try block`).toHaveLength(1)
  const argument = reports[0].arguments[0]
  expect(argument, `${handlerName} reports nothing`).toBeDefined()
  // A message computed into a local first is the same claim, so the
  // dataflow is followed one hop through such a declaration.
  let expression: ts.Expression = argument!
  if (ts.isIdentifier(expression)) {
    const local = findDeclarationsOf(tryStatement.tryBlock, expression.text)[0]
    if (local?.declaration.initializer !== undefined) expression = local.declaration.initializer
  }
  // Whatever inside the reported expression carries the IPC call's result:
  // the `await` itself when it is written inline, or every mention of the
  // local the await was assigned to.
  const carriers = new Set<ts.Node>(
    findAll(expression, ts.isAwaitExpression).filter(
      (await_) => ts.isCallExpression(await_.expression) &&
        flattenPropertyAccess(await_.expression.expression) === ipc
    )
  )
  for (const id of findAll(expression, ts.isIdentifier)) {
    const resolved = resolveAwaitedCall(tryStatement.tryBlock, id)
    if (resolved !== undefined && flattenPropertyAccess(resolved.expression) === ipc) carriers.add(id)
  }
  expect(
    [...carriers].map((node) => node.getText()),
    `${handlerName}’s reported message does not carry the awaited result of ${ipc}`
  ).not.toHaveLength(0)
  expect(
    valueVariesWith(expression, carriers),
    `${handlerName} reports \`${expression.getText()}\`, whose value cannot differ according to what ${ipc} returned — it says the same thing whatever happened`
  ).toBe(true)
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

  // Wave 6, F-9 (F5): sync calling the real IPC and sync REPORTING what it
  // returned are two different claims, and only the first was pinned — a
  // handler that awaited syncLane and then announced "Lane synced"
  // regardless told the user a conflicted sync had succeeded while every
  // other assertion in this file stayed green. The message it reports has
  // to be computed from the value the call handed back.
  it('reports the result sync actually received, not a fixed message', () => {
    expectReportsWhatItReceived('sync', 'window.crew.syncLane')
  })

  // Wave 7, F-9 (X6): F5 was closed for sync and only for sync. Publish
  // could await the real publishLane call, throw the answer away and
  // announce a fixed 'Published' — a failed, refused or conflicted
  // publication reported as a success — with every assertion in this file
  // still green.
  it('reports the result publish actually received, not a fixed message', () => {
    expectReportsWhatItReceived('publish', 'window.crew.publishLane')
  })

  it('wraps publish in a real try/catch, calling describeUnexpectedFailure in the catch block', () => {    const { tryStatement } = handlerParts('publish')
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

    // Wave 5, N1: the effect's assignment being right is not enough while
    // anything ELSE may assign the ref too. A `shownWorkspace.current =
    // workspaceId` in publish's `finally` re-points it at the workspace the
    // handler was started for, so a result belonging to the workspace the
    // user has already left passes both guards and is drawn anyway. The ref
    // is written in exactly one place: the effect pinned above.
    //
    // Wave 6, F-9: and it is the BINDING that is inspected, not the text
    // `shownWorkspace.current`. Six mutations wrote to the ref in spellings
    // a text comparison never saw — `shownWorkspace['current'] = …`,
    // `(shownWorkspace.current) = …`, `;[shownWorkspace.current] = […]`,
    // `Object.assign(shownWorkspace, {current: …})`, a write through an
    // alias, and the alias itself. Every mention of the binding is
    // classified: it may be read as `shownWorkspace.current`, written once,
    // and mentioned in no other way at all — because a ref that escapes can
    // be written from anywhere, which would make the count below meaningless.
    const uses = findRefUses(source, 'shownWorkspace')
    expect(
      uses.escapes.map((id) => id.parent.getText()),
      'shownWorkspace is mentioned other than as shownWorkspace.current — an alias or a computed write escapes both drop guards'
    ).toHaveLength(0)
    expect(
      uses.writes.map((write) => write.parent.getText()),
      'shownWorkspace.current is written somewhere other than the [workspaceId] effect, which defeats both drop guards'
    ).toHaveLength(1)
    expect(
      isWithin(uses.writes[0], updating[0]),
      'the one write to shownWorkspace.current is not the one inside the [workspaceId] effect'
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
    // confined to the places entitled to it: its own useState binding and
    // the guarded reporter.
    //
    // Wave 5, N4: "anywhere inside a useEffect callback" was too generous.
    // `say.current = setMessage` inside the effect, called as
    // `say.current(...)` from sync, is an alias the old allow-list waved
    // through. The effect's entitlement is exactly one thing — clearing the
    // message on a workspace switch — so only `setMessage(null)` called by
    // the [workspaceId] effect itself is allowed, and every other mention
    // anywhere is a stray.
    const declaration = findUseStateDeclaration(source, 'setMessage')
    expect(declaration, 'setMessage is not bound by a real useState() call').toBeDefined()
    // Wave 7, F-9 (X5): `const { 0: message, 1: setMessage, 1: say } =
    // useState(…)` binds the setter twice, so `say('…')` is an unguarded
    // second name for it that nothing keyed on `setMessage` can see.
    expect(
      duplicateBoundKeys(declaration!.name),
      'the useState binding names one of its slots twice, so the setter has a second name the workspace guard does not cover'
    ).toHaveLength(0)
    const workspaceEffects = findEffectCalls(source).filter((call) => {
      const deps = call.arguments[1]
      return deps !== undefined && ts.isArrayLiteralExpression(deps) &&
        deps.elements.some((el) => el.getText() === 'workspaceId')
    })
    // Wave 6, F-9 (F4, F11): "the effect clears the message somewhere" was
    // satisfied by `if (cancelled) setMessage(null)` — a clear that does
    // not happen on a workspace switch — and by an early `return` placed
    // above the clear, which skips it entirely for the workspace the user
    // just moved to. The clear must be a statement the effect runs
    // outright, with nothing ahead of it that could decide otherwise.
    const clearing = workspaceEffects
      .flatMap((call) => {
        const effect = call.arguments[0]!
        return findDirectCallsTo(effect, 'setMessage')
          .filter((set) => isUnconditionalLeadingStatement(effect, set))
      })
      .filter((call) => call.arguments.length === 1 && call.arguments[0].getText() === 'null')
    expect(
      clearing,
      'the [workspaceId] effect does not unconditionally clear the message with setMessage(null) before anything can return'
    ).toHaveLength(1)
    // Wave 6, F-9 (F3): `report` used to be allow-listed WHOLESALE, so
    // stashing the setter inside it (`say.current = setMessage`) and
    // calling it from sync put an unguarded message on screen while every
    // assertion here stayed green. Inside report the setter may only be
    // CALLED — the guarded calls pinned above — and nowhere else may it be
    // named at all.
    const entitled = new Set<ts.Node>([...sets, ...clearing].map((call) => call.expression))
    const stray = findIdentifiers(source, 'setMessage').filter(
      (id) => !isWithin(id, declaration!.name) && !entitled.has(id)
    )
    expect(
      stray.map((id) => id.parent.getText()),
      'setMessage is named outside the guarded calls in report() and the workspace effect’s setMessage(null) — an alias, a stashed ref or a .then(setMessage) bypasses the workspace guard'
    ).toHaveLength(0)
  })

  // Wave 3 finding 4 (second half): every assertion in this file that names
  // `workspaceId` assumes it still means the prop. Reassigning or shadowing
  // it inside a handler would satisfy all of them while the handler acted on
  // some other workspace entirely.
  it('never reassigns or shadows the workspaceId prop', () => {
    // Wave 7, F-9 (X3, X3b, X3c): this compared the left-hand side's TEXT
    // and the assignment's operator, so `;[workspaceId] = […]`,
    // `(workspaceId) = …` and `workspaceId ||= …` all re-pointed the
    // prop's binding unseen — which defeats report()'s drop guard, since
    // the guard asks whether the panel still shows `workspaceId`. Writes
    // are found by POSITION in the syntax tree now, exactly as the ref's
    // are.
    expect(
      findWritesTo(source, 'workspaceId').map((write) => write.parent.getText()),
      'workspaceId is reassigned'
    ).toHaveLength(0)
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
        findWritesTo(handler!, 'outcome').map((write) => write.parent.getText()),
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
