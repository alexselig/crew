// Creating a workspace is a React flow, and under vitest's `environment:
// 'node'` config there is no DOM to run it in. Its decisions already live in
// a pure function — planNewWorkspace in src/shared/conductor-entry.ts,
// covered directly in conductor-entry.test.ts. What is left to pin here is
// the WIRING: that the manager actually consumes that plan, that it activates
// the workspace it was told to activate, that it selects the session it was
// just handed rather than hunting for it in a roster it has not received yet,
// and that a conductor which fails to start is reported instead of vanishing.
//
// Like conductor-app-mount.test.ts, this walks the real TypeScript AST: a
// comment or string literal containing the same text is not a CallExpression
// and cannot satisfy any assertion below.
import * as ts from 'typescript'
import { describe, it, expect } from 'vitest'
import {
  parseSource,
  hasNamedImport,
  findAll,
  findCallsTo,
  findDirectCallsTo,
  findEffectCalls,
  findFunctionVariable,
  findJsxTags,
  findTryStatement,
  isWithin,
  jsxAttributeValue,
  resolveAwaitedCall
} from './helpers/ts-ast'

const manager = parseSource('src/renderer/components/WorkspaceManager.tsx')
const dialog = parseSource('src/renderer/components/NewWorkspaceDialog.tsx')
const app = parseSource('src/renderer/App.tsx')

function finishCreate(): ts.ArrowFunction | ts.FunctionExpression {
  const fn = findFunctionVariable(manager, 'finishCreate')
  expect(fn, 'WorkspaceManager has no finishCreate function').toBeDefined()
  return fn!
}

describe('WorkspaceManager — what creating a workspace leads to', () => {
  it('decides through the pure plan rather than rebuilding the request inline', () => {
    expect(hasNamedImport(manager, '../../shared/conductor-entry', 'planNewWorkspace')).toBe(true)
    const calls = findCallsTo(finishCreate().body!, 'planNewWorkspace')
    expect(calls, 'finishCreate does not call planNewWorkspace').toHaveLength(1)
    // The plan is made for the workspace main actually created, with the
    // choice the dialog returned and the presets the manager was given.
    expect(calls[0].arguments.map((a) => a.getText())).toEqual(['created', 'choice', 'presets'])
  })

  it('makes the workspace it just created the active one', () => {
    // The HIGH finding: openSession -> navigateToSession only ever CLEARS
    // the workspace filter, so a new conducted workspace was never made
    // active, activeWorkspaceConducted stayed false, and the user landed on
    // a conductor session with no conductor panel at all.
    const body = finishCreate().body!
    const activations = findDirectCallsTo(body, 'onActivateWorkspace')
    expect(activations, 'finishCreate never activates a workspace').toHaveLength(1)
    expect(
      activations[0].arguments[0]?.getText(),
      'finishCreate activates something other than the workspace the plan named'
    ).toBe('plan.activateWorkspaceId')
    // And it must not go through the helper that clears the filter instead.
    expect(
      findDirectCallsTo(body, 'openSession'),
      'finishCreate still routes through openSession, which clears the workspace filter'
    ).toHaveLength(0)
    expect(findDirectCallsTo(body, 'onOpenSession')).toHaveLength(0)
  })

  it('creates the planned session and selects it by the id that came back', () => {
    const body = finishCreate().body!
    const created = findCallsTo(body, 'window.crew.createSession')
    expect(created, 'finishCreate does not create a session').toHaveLength(1)
    expect(
      created[0].arguments[0]?.getText(),
      'the session request is not the one the plan produced'
    ).toBe('plan.session')

    const selections = findDirectCallsTo(body, 'onSelectSession')
    expect(selections, 'finishCreate never selects the session it created').toHaveLength(1)
    const argument = selections[0].arguments[0]
    expect(argument && ts.isPropertyAccessExpression(argument) && argument.name.text).toBe('id')
    // The id belongs to the SessionInfo createSession resolved with — not to
    // something found in the roster, which the creating window has not been
    // told about yet.
    const owner = (argument as ts.PropertyAccessExpression).expression
    expect(resolveAwaitedCall(body, owner)).toBe(created[0])
  })

  it('reports a conductor that refused to start instead of leaving an empty workspace', () => {
    const body = finishCreate().body!
    const attempt = findTryStatement(body)
    expect(attempt, 'createSession is not attempted inside a try').toBeDefined()
    expect(
      isWithin(findCallsTo(body, 'window.crew.createSession')[0], attempt!.tryBlock),
      'createSession is outside the try block, so its rejection is unobserved'
    ).toBe(true)
    expect(attempt!.catchClause).toBeDefined()
    expect(
      findDirectCallsTo(attempt!.catchClause!.block, 'setCreateError'),
      'a failed conductor is caught but never shown to anyone'
    ).not.toHaveLength(0)
  })

  it('keeps the dialog and everything typed into it when the name is refused', () => {
    // createWorkspace returns null for a blank or duplicate name. Clearing
    // pendingName before that is known threw away the repository path and
    // the brief with it, with no message at all.
    const body = finishCreate().body!
    const closes = findDirectCallsTo(body, 'setPendingName')
    expect(closes, 'finishCreate never closes the dialog').not.toHaveLength(0)
    const nullCheck = findAll(body, ts.isIfStatement).find((statement) => {
      const condition = statement.expression
      return ts.isPrefixUnaryExpression(condition) &&
        condition.operator === ts.SyntaxKind.ExclamationToken &&
        condition.operand.getText() === 'created'
    })
    expect(nullCheck, 'finishCreate does not check whether a workspace was created').toBeDefined()
    expect(
      closes.every((close) => close.pos > nullCheck!.end),
      'the dialog is closed before main has said whether the name was accepted'
    ).toBe(true)
    expect(
      findDirectCallsTo(nullCheck!.thenStatement, 'setCreateError'),
      'a refused name says nothing to the user'
    ).not.toHaveLength(0)
  })

  it('refuses a name that is already taken before the dialog is even opened', () => {
    expect(hasNamedImport(manager, '../../shared/workspaces', 'workspaceNameAvailable')).toBe(true)
    const begin = findFunctionVariable(manager, 'beginCreate')
    expect(begin).toBeDefined()
    expect(findCallsTo(begin!.body!, 'workspaceNameAvailable')).toHaveLength(1)
  })

  it('observes the promise it starts from the dialog', () => {
    const tags = findJsxTags(manager, 'NewWorkspaceDialog')
    expect(tags).toHaveLength(1)
    const onCreate = jsxAttributeValue(tags[0], 'onCreate')
    expect(onCreate).toBeDefined()
    const calls = findCallsTo(onCreate!, 'finishCreate')
    expect(calls).toHaveLength(1)
    // `void finishCreate(choice)` alone turns any rejection into an
    // unhandled one the user never hears about.
    const caught = findAll(onCreate!, ts.isCallExpression).filter((call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'catch' &&
      call.expression.expression === calls[0]
    )
    expect(
      caught,
      'the dialog starts finishCreate without catching its rejection'
    ).toHaveLength(1)
    // The dialog is told what already exists and what went wrong, so a name
    // it cannot use is refused with the form still filled in.
    expect(jsxAttributeValue(tags[0], 'workspaces')).toBeDefined()
    expect(jsxAttributeValue(tags[0], 'error')).toBeDefined()
  })
})

describe('NewWorkspaceDialog — a refused name is fixable', () => {
  it('checks the name by the same rule main creates with', () => {
    expect(hasNamedImport(dialog, '../../shared/workspaces', 'workspaceNameAvailable')).toBe(true)
    expect(findCallsTo(dialog, 'workspaceNameAvailable')).toHaveLength(1)
  })

  it('submits the name the user can still edit, not the one it opened with', () => {
    const submit = findFunctionVariable(dialog, 'submit')
    expect(submit).toBeDefined()
    const creates = findDirectCallsTo(submit!.body!, 'onCreate')
    expect(creates).toHaveLength(1)
    const argument = creates[0].arguments[0]
    expect(argument && ts.isObjectLiteralExpression(argument)).toBe(true)
    const nameProperty = (argument as ts.ObjectLiteralExpression).properties.find(
      (property) => property.name?.getText() === 'name'
    )
    expect(nameProperty, 'the submitted choice carries no name').toBeDefined()
    expect(
      (nameProperty as ts.PropertyAssignment).initializer.getText(),
      'the dialog submits a name the user had no chance to correct'
    ).toContain('chosenName')
  })
})

describe('App — conductor UI cannot outlive the workspace it was opened in', () => {
  it('hands the manager the ways to activate a workspace and select a session', () => {
    const tags = findJsxTags(app, 'WorkspaceManager')
    expect(tags).toHaveLength(1)
    const activate = jsxAttributeValue(tags[0], 'onActivateWorkspace')
    expect(activate?.getText()).toBe('c.setActiveWorkspace')
    const select = jsxAttributeValue(tags[0], 'onSelectSession')
    expect(select?.getText()).toBe('c.selectSession')
  })

  it('closes the composer and drops a loaded plan on ANY change of workspace', () => {
    // Conductedness is not enough: leaving conducted A for conducted B keeps
    // the flag true, so an effect watching only that never fires — and the
    // draft written for A is composed into B's live runtime. The app menu's
    // Change Workspace works while a modal is open, which is the path.
    const effects = findEffectCalls(app).filter((call) => {
      const deps = call.arguments[1]
      return deps !== undefined && ts.isArrayLiteralExpression(deps) &&
        deps.elements.some((el) => el.getText() === 'activeWorkspaceConducted')
    })
    expect(effects, 'no effect reacts to the workspace ceasing to be conducted').toHaveLength(1)
    const deps = effects[0].arguments[1] as ts.ArrayLiteralExpression
    expect(
      deps.elements.some((el) => el.getText() === 'c.activeWorkspace'),
      'the effect ignores which workspace it is, so conducted A to conducted B never clears'
    ).toBe(true)
    const body = effects[0].arguments[0]!
    for (const [setter, value] of [
      ['setShowConductorComposer', 'false'],
      ['setConductorPlan', 'null'],
      ['setConductorPlanError', 'null']
    ]) {
      const calls = findDirectCallsTo(body, setter)
      expect(calls, `${setter} is never called when the workspace changes`).toHaveLength(1)
      expect(calls[0].arguments[0]?.getText()).toBe(value)
    }
    // Nothing may short-circuit the clear: an early-out on conductedness is
    // exactly what let A's composer survive into B.
    expect(
      findAll(body, ts.isReturnStatement),
      'the effect still returns early, so a conducted-to-conducted switch clears nothing'
    ).toHaveLength(0)
  })

  it('refuses to compose a draft whose workspace moved out from under it', () => {
    const compose = findFunctionVariable(app, 'composeConductedWorkspace')
    expect(compose).toBeDefined()
    const checks = findCallsTo(compose!, 'conductorWorkStillApplies')
    expect(checks, 'compose never asks whether this draft still belongs here').toHaveLength(1)
    // Decided before main is told anything: main's own check only asks
    // whether the workspace is conducted, and the one switched to is.
    const call = findCallsTo(compose!, 'window.crew.composeConductedWorkspace')[0]
    expect(call).toBeDefined()
    expect(checks[0].getStart()).toBeLessThan(call.getStart())
    expect(checks[0].arguments.map((a) => a.getText())).toEqual([
      'conductorWorkspaceRef.current',
      'c.activeWorkspace'
    ])
  })

  it('captures the workspace a composer or a plan was opened in', () => {
    const writes = findAll(app, ts.isBinaryExpression).filter(
      (b) =>
        b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        b.left.getText() === 'conductorWorkspaceRef.current'
    )
    expect(writes, 'the composer and the plan loader do not both record their workspace').toHaveLength(2)
    // Opening by hand records the workspace the button was pressed in.
    const panel = findJsxTags(app, 'ConductorPanel')[0]
    const byHand = jsxAttributeValue(panel, 'onComposeByHand')
    expect(byHand).toBeDefined()
    expect(writes.some((w) => isWithin(w, byHand!))).toBe(true)
  })

  it('drops a plan whose model catalogue arrived after a workspace switch', () => {
    // file.text() and listCopilotModels() are both out of process, so the
    // window between dropping a plan file and showing the dialog is seconds
    // wide — long enough to change workspace, and the clearing effect runs
    // before there is anything to clear.
    const load = findFunctionVariable(app, 'loadConductorPlanFile')
    expect(load).toBeDefined()
    const checks = findCallsTo(load!, 'conductorWorkStillApplies')
    expect(checks, 'the plan loader never re-checks its workspace after awaiting').not.toHaveLength(0)
    const opens = findDirectCallsTo(load!, 'setConductorPlan')
    expect(opens).toHaveLength(1)
    // The check that matters is the one AFTER the model catalogue comes
    // back; a check before the awaits only ever compares a workspace with
    // itself.
    const catalogue = findCallsTo(load!, 'window.crew.listCopilotModels')[0]
    expect(catalogue).toBeDefined()
    const afterCatalogue = checks.filter(
      (check) => check.getStart() > catalogue.getStart() && check.getStart() < opens[0].getStart()
    )
    expect(
      afterCatalogue,
      'the plan dialog is opened without re-checking the workspace the catalogue call was made for'
    ).not.toHaveLength(0)
    // Every one of these checks must read a live cell. useCrew returns a new
    // object each render, so an async body closes over the c of the render
    // that started it: comparing it with the value read from it before the
    // await compares a value with itself, and the guard can never fire — the
    // exact tautology this test replaces.
    for (const check of checks) {
      const second = check.arguments[1]
      expect(second, 'the check has no second argument to compare against').toBeDefined()
      expect(
        ts.isPropertyAccessExpression(second!) && second.name.text === 'current',
        `the workspace check compares against ${second!.getText()}, which the closure captured — it can never differ`
      ).toBe(true)
      expect(second!.getText()).not.toBe(check.arguments[0]?.getText())
    }
    // Captured once, up front, from the workspace that was active then.
    const captured = findAll(load!, ts.isVariableDeclaration).filter(
      (d) => d.name.getText() === 'openedIn'
    )
    expect(captured, 'the plan loader never captures the workspace it was dropped into').toHaveLength(1)
    expect(captured[0].initializer?.getText()).toBe('c.activeWorkspace')
    const firstAwait = findAll(load!, ts.isAwaitExpression)[0]
    expect(firstAwait).toBeDefined()
    expect(captured[0].getStart()).toBeLessThan(firstAwait.getStart())
  })

  it('keeps the workspace it compares against live across a render', () => {
    const writes = findAll(app, ts.isBinaryExpression).filter(
      (b) =>
        b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        b.left.getText() === 'activeWorkspaceRef.current'
    )
    expect(writes, 'nothing ever updates the workspace the async guards read').not.toHaveLength(0)
    expect(writes.some((w) => w.right.getText() === 'c.activeWorkspace')).toBe(true)
  })

  it('mounts neither modal outside a conducted workspace', () => {
    // Belt and braces with the effect: the effect clears after a render, the
    // guard keeps both modals off screen in the frame in between.
    for (const state of ['showConductorComposer', 'conductorPlan']) {
      const mounts = findAll(app, ts.isJsxExpression).filter((node) =>
        node.expression !== undefined &&
        findIdentifierText(node.expression).includes(state) &&
        findAll(node, ts.isJsxElement).length > 0
      )
      expect(mounts, `nothing renders ${state}`).not.toHaveLength(0)
      expect(
        mounts.every((node) => findIdentifierText(node.expression!).includes('activeWorkspaceConducted')),
        `${state} is mounted without asking whether this workspace is conducted`
      ).toBe(true)
    }
  })

  it('never paints a plan-load error outside a conducted workspace', () => {
    // The effect above clears it, but only after a render: the guard is what
    // keeps the error off screen in the frame in between.
    const errors = findAll(app, ts.isJsxExpression).filter((node) =>
      node.expression !== undefined &&
      findIdentifierText(node.expression).includes('conductorPlanError') &&
      findAll(node, ts.isJsxElement).length > 0
    )
    expect(errors, 'nothing renders conductorPlanError').not.toHaveLength(0)
    expect(
      errors.some((node) => findIdentifierText(node.expression!).includes('activeWorkspaceConducted')),
      'the plan-load error is rendered without asking whether this workspace is conducted'
    ).toBe(true)
  })
})

function findIdentifierText(node: ts.Node): string[] {
  return findAll(node, ts.isIdentifier).map((id) => id.text)
}
