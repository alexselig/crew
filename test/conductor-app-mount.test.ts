// App.tsx renders no DOM under vitest's `environment: 'node'` config, so this
// coverage — like conductor-plan-document.test.ts's own security scan — reads
// the compiled source directly. Task 7 fix round 1, Finding 2: the previous
// version of this file used plain substring/regex scans, which still pass
// when the wiring they claim to pin is deleted and replaced by a comment (or
// a string literal) containing the same text. This version walks the real
// TypeScript AST (via `typescript`, already a repo dependency) so each
// assertion is proof of an actual ImportDeclaration, JsxElement, or
// CallExpression — a comment or string literal simply is not one of those
// node kinds and cannot satisfy these checks.
import * as ts from 'typescript'
import { describe, it, expect } from 'vitest'
import {
  parseSource,
  hasNamedImport,
  findJsxTags,
  enclosingLogicalAndGuard,
  jsxAttributeValue,
  findFunctionVariable,
  findCallsTo,
  findAll
} from './helpers/ts-ast'

const source = parseSource('src/renderer/App.tsx')

describe('App.tsx — mounting the composer and plan dialog', () => {
  it('imports both components via real import declarations (review finding 12: today nothing renders either)', () => {
    expect(hasNamedImport(source, './components/ConductorComposer', 'ConductorComposer')).toBe(true)
    expect(hasNamedImport(source, './components/ConductorPlanDialog', 'ConductorPlanDialog')).toBe(true)
  })

  it('renders ConductorComposer as a real JSX element behind the showConductorComposer guard, not merely importing it', () => {
    const tags = findJsxTags(source, 'ConductorComposer')
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.some((tag) => enclosingLogicalAndGuard(tag) === 'showConductorComposer')).toBe(true)
  })

  it('renders ConductorPlanDialog as a real JSX element behind the conductorPlan guard, not merely importing it', () => {
    const tags = findJsxTags(source, 'ConductorPlanDialog')
    expect(tags.length).toBeGreaterThan(0)
    expect(tags.some((tag) => enclosingLogicalAndGuard(tag) === 'conductorPlan')).toBe(true)
  })

  it('wires composeConductedWorkspace to the real IPC call, not a stub', () => {
    const fn = findFunctionVariable(source, 'composeConductedWorkspace')
    expect(fn).toBeDefined()
    const calls = findCallsTo(fn!.body!, 'window.crew.composeConductedWorkspace')
    expect(calls).toHaveLength(1)
    // Review finding 1: the workspace is named by the call, and it is the
    // renderer's own active workspace — main has no active workspace of its
    // own for conductor to guess from.
    expect(calls[0].arguments[0]?.getText()).toBe('c.activeWorkspace')
    expect(calls[0].arguments[1]?.getText()).toBe('draft')
  })

  it('tells the conductor panel which workspace it is showing', () => {
    const tags = findJsxTags(source, 'ConductorPanel')
    expect(tags).toHaveLength(1)
    const value = jsxAttributeValue(tags[0], 'workspaceId')
    expect(value).toBeDefined()
    expect(value!.getText()).toBe('c.activeWorkspace')
  })

  it('passes the real composeConductedWorkspace function (not an inline stub) as onCompose to both mount points', () => {
    const tags = [...findJsxTags(source, 'ConductorComposer'), ...findJsxTags(source, 'ConductorPlanDialog')]
    const onComposeValues = tags
      .map((tag) => jsxAttributeValue(tag, 'onCompose'))
      .filter((v): v is ts.Expression => v !== undefined)
    expect(onComposeValues).toHaveLength(2)
    expect(onComposeValues.every((v) => ts.isIdentifier(v) && v.text === 'composeConductedWorkspace')).toBe(true)
  })

  it('gives ConductorPanel real callback expressions for onNewWorkspace/onLoadPlan, rather than mounting it bare', () => {
    const [tag] = findJsxTags(source, 'ConductorPanel')
    expect(tag).toBeDefined()
    const onNewWorkspace = jsxAttributeValue(tag, 'onNewWorkspace')
    const onLoadPlan = jsxAttributeValue(tag, 'onLoadPlan')
    expect(onNewWorkspace).toBeDefined()
    expect(onLoadPlan).toBeDefined()
    expect(findCallsTo(onNewWorkspace!, 'setShowConductorComposer').length).toBeGreaterThan(0)
    expect(findCallsTo(onLoadPlan!, 'loadConductorPlanFile').length).toBeGreaterThan(0)
  })

  it('closes the composer/plan dialog only inside the result.ok branch of composeConductedWorkspace', () => {
    // Regression this guards against: closing on every call regardless of
    // ComposeResult, which would hide a failed compose (including the
    // survivingLanes arm) instead of leaving the dialog open to show it.
    const fn = findFunctionVariable(source, 'composeConductedWorkspace')!
    const okGuard = findAll(fn.body!, ts.isIfStatement).find((ifs) => {
      const cond = ifs.expression
      return ts.isPropertyAccessExpression(cond) && cond.name.text === 'ok'
    })
    expect(okGuard).toBeDefined()

    const closeCalls = findCallsTo(okGuard!.thenStatement, 'setShowConductorComposer')
    const clearCalls = findCallsTo(okGuard!.thenStatement, 'setConductorPlan')
    expect(closeCalls.some((c) => c.arguments[0]?.getText() === 'false')).toBe(true)
    expect(clearCalls.some((c) => c.arguments[0]?.getText() === 'null')).toBe(true)

    // The two calls must live ONLY inside the ok-guarded branch: outside of
    // it (the rest of the function body), neither call may appear at all.
    const wholeBodyCloseCalls = findCallsTo(fn.body!, 'setShowConductorComposer')
    const wholeBodyClearCalls = findCallsTo(fn.body!, 'setConductorPlan')
    expect(wholeBodyCloseCalls).toHaveLength(closeCalls.length)
    expect(wholeBodyClearCalls).toHaveLength(clearCalls.length)
  })
})
