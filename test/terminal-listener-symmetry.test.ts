// A pane adds window- and document-level listeners and must remove exactly the same
// function on unmount. Passing a different-but-similar callback to
// removeEventListener is silent: nothing throws, the tests pass, and every pane
// that has ever mounted keeps re-fitting forever. With a large roster that is a
// listener per pane per mount, each holding the engine and host closure alive.
//
// This was a real near-miss: wrapping the focus fit in a retry updated the
// addEventListener call and left removeEventListener pointing at the old
// function.
//
// Identity is a property of the source, not of behaviour reachable from a Node
// test (App.tsx and CrewTerminal render no DOM under `environment: 'node'`), so
// this walks the AST the way conductor-app-mount.test.ts does.
import * as ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { parseSource, findCallsTo, findAll } from './helpers/ts-ast'

const FILES = ['src/renderer/components/CrewTerminal.tsx', 'src/renderer/components/TerminalView.tsx']

// Only `window` and `document` are checked. Both outlive every component, so a
// listener left on them leaks the whole closure -- engine, host element and all
// -- once per pane per mount. Listeners on an element the component owns are
// collected with that element, and some are deliberately never removed.
const GLOBAL_TARGETS = ['window', 'document']

/** (event, handlerText) for each <target>.<kind>EventListener call. */
function globalListeners(source: ts.SourceFile, kind: 'add' | 'remove'): Array<[string, string]> {
  return GLOBAL_TARGETS.flatMap((target) => findCallsTo(source, `${target}.${kind}EventListener`))
    .map((call): [string, string] | null => {
      const [event, handler] = call.arguments
      if (!event || !handler || !ts.isStringLiteralLike(event)) return null
      return [event.text, handler.getText()]
    })
    .filter((p): p is [string, string] => p !== null)
}

describe.each(FILES)('%s — global listener symmetry', (file) => {
  const source = parseSource(file)
  const added = globalListeners(source, 'add')
  const removed = globalListeners(source, 'remove')

  it('removes every window/document listener it adds, by the same reference', () => {
    for (const [event, handler] of added) {
      expect(
        removed,
        `addEventListener('${event}', ${handler}) has no matching removeEventListener with the same function`
      ).toContainEqual([event, handler])
    }
  })

  it('passes a named reference, never an inline function, to addEventListener', () => {
    // An inline arrow cannot be removed at all -- the symmetry check above
    // would be satisfiable only by a second, equally unremovable literal.
    for (const [event, handler] of added) {
      const node = findAll(source, ts.isCallExpression)
        .filter((c) => c.arguments[1]?.getText() === handler)[0]
        ?.arguments[1]
      expect(
        node && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node),
        `addEventListener('${event}', ...) must take a named function so it can be removed`
      ).toBe(true)
    }
  })
})
