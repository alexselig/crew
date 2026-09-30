// Shared AST-walking helpers for the source-text tests that pin real wiring
// (conductor-app-mount, conductor-panel-wiring, conductor-composer). Task 7
// fix round 1, Finding 2: plain substring/regex scans over raw source pass
// even when the wiring they claim to pin is deleted and replaced by a
// comment or a matching string literal -- the exact bypass a previous task
// on this branch already shipped once. Walking the real TypeScript AST (via
// `typescript`, already a repo dependency -- no new dependency added) means
// a comment or a string literal containing the same text is not a
// SyntaxKind.ImportDeclaration, JsxElement, or CallExpression, and so simply
// cannot satisfy these assertions.
import * as ts from 'typescript'
import { readFileSync } from 'node:fs'

/** `ts.createSourceFile` alone never surfaces parse errors to the caller — a
 *  file that fails to parse still hands back an empty or partial tree, and
 *  every `findAll`-based assertion over it then passes vacuously (nothing
 *  found == "no violation"). Diagnostics therefore come from a real
 *  `ts.Program`'s public `getSyntacticDiagnostics`, over a compiler host
 *  that serves the very SourceFile returned here — no internal
 *  `parseDiagnostics` field, and no `?? []` fallback that would silently
 *  restore the vacuous pass if that field ever went away (review: deferred
 *  minor). `setParentNodes: true` is kept so every node's `.getText()`
 *  still works. */
export function parseSource(path: string): ts.SourceFile {
  const text = readFileSync(path, 'utf8')
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === path ? source : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '',
    getDirectories: () => [],
    fileExists: (name) => name === path,
    readFile: (name) => (name === path ? text : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n'
  }
  const program = ts.createProgram(
    [path],
    { noResolve: true, noLib: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest },
    host
  )
  const diagnostics = program.getSyntacticDiagnostics(source)
  if (diagnostics.length > 0) {
    const messages = diagnostics
      .map((d) => `${path}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
      .join('\n')
    throw new Error(`parseSource: syntactic errors in ${path}:\n${messages}`)
  }
  return source
}

function walk(root: ts.Node, visit: (n: ts.Node) => void): void {
  visit(root)
  ts.forEachChild(root, (child) => walk(child, visit))
}

export function findAll<T extends ts.Node>(root: ts.Node, test: (n: ts.Node) => n is T): T[] {
  const out: T[] = []
  walk(root, (n) => {
    if (test(n)) out.push(n)
  })
  return out
}

/** Flattens `a.b.c` (PropertyAccessExpression chains over Identifiers) or a
 *  bare identifier into its dotted text, so a real call expression's callee
 *  can be compared against e.g. "window.crew.composeConductedWorkspace"
 *  without caring about surrounding whitespace/formatting. Returns undefined
 *  for anything else (a computed access, a call, etc). */
export function flattenPropertyAccess(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) {
    const left = flattenPropertyAccess(node.expression)
    return left === undefined ? undefined : `${left}.${node.name.text}`
  }
  return undefined
}

/** True iff a real `import { name } from '.../suffix'` declaration exists —
 *  not a comment or string mentioning the same text. */
export function hasNamedImport(source: ts.SourceFile, moduleSuffix: string, name: string): boolean {
  return findAll(source, ts.isImportDeclaration).some((decl) => {
    if (!ts.isStringLiteral(decl.moduleSpecifier) || !decl.moduleSpecifier.text.endsWith(moduleSuffix)) return false
    const namedBindings = decl.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) return false
    return namedBindings.elements.some((el) => el.name.text === name)
  })
}

export type JsxTag = ts.JsxSelfClosingElement | ts.JsxOpeningElement

function tagNameOf(tag: JsxTag): string {
  const name = tag.tagName
  return ts.isIdentifier(name) ? name.text : name.getText()
}

/** Every JSX tag (self-closing, or the opening tag of a paired element) in
 *  the file with the given component name. */
export function findJsxTags(source: ts.SourceFile, componentName: string): JsxTag[] {
  const selfClosing = findAll(source, ts.isJsxSelfClosingElement).filter((n) => tagNameOf(n) === componentName)
  const opening = findAll(source, ts.isJsxOpeningElement).filter((n) => tagNameOf(n) === componentName)
  return [...selfClosing, ...opening]
}

/** Walks upward from a JSX tag to the nearest enclosing `{cond && <Tag/>}`
 *  guard and returns the source text of `cond`, or undefined if the tag is
 *  not behind one at all — the real-AST replacement for indexOf-ing a flag
 *  string and hoping the tag textually follows it. Handles both a bare
 *  `{cond && <Tag/>}` and a parenthesized `{cond && (<div><Tag/></div>)}`,
 *  since the tag may be nested inside an overlay wrapper rather than being
 *  the `&&`'s direct right operand. */
export function enclosingLogicalAndGuard(tag: JsxTag): string | undefined {
  // A JsxOpeningElement's rendered element is its parent JsxElement; a
  // JsxSelfClosingElement IS the rendered element.
  let node: ts.Node = ts.isJsxOpeningElement(tag) ? tag.parent : tag
  while (node.parent) {
    const parent = node.parent
    if (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === node) {
      return parent.left.getText()
    }
    node = parent
  }
  return undefined
}

/** The initializer expression of a JSX attribute (`attr={expr}` or
 *  `attr="literal"`), or undefined if the attribute is absent. */
export function jsxAttributeValue(tag: JsxTag, attrName: string): ts.Expression | undefined {
  const attrs = ts.isJsxOpeningElement(tag) ? tag.attributes : tag.attributes
  for (const prop of attrs.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === attrName) {
      const init = prop.initializer
      if (!init) return undefined
      return ts.isJsxExpression(init) ? init.expression ?? undefined : init
    }
  }
  return undefined
}

/** The initializer (arrow function / function expression) of a top-level
 *  `const name = ...` declaration, found anywhere in the file — real
 *  function identity, not a string match on "const name". */
export function findFunctionVariable(source: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const decl = findAll(source, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === name)
  const init = decl?.initializer
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init
  return undefined
}

/** Same as `findFunctionVariable`, but for `const name = useCallback(fn, deps)`
 *  — unwraps the useCallback() call to reach the real handler, so a rewrite
 *  that keeps the useCallback() call around but guts the handler body still
 *  fails these checks (the handler node itself is what gets inspected). */
export function findCallbackVariable(source: ts.SourceFile, name: string): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const decl = findAll(source, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === name)
  const init = decl?.initializer
  if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback') {
    const handler = init.arguments[0]
    if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) return handler
  }
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init
  return undefined
}

/** Every call expression inside `root` whose flattened callee text equals
 *  `calleeText` (e.g. "window.crew.composeConductedWorkspace"). */
export function findCallsTo(root: ts.Node, calleeText: string): ts.CallExpression[] {
  return findAll(root, ts.isCallExpression).filter((call) => flattenPropertyAccess(call.expression) === calleeText)
}

/** The nearest TryStatement inside `root`, or undefined. */
export function findTryStatement(root: ts.Node): ts.TryStatement | undefined {
  return findAll(root, ts.isTryStatement)[0]
}

/** Every `X().then(argText)` call inside `root`, where `X` flattens to
 *  `baseCallee` (e.g. "window.crew.getConductorState"). Distinct from
 *  `findCallsTo`, which only flattens identifier/property-access chains —
 *  the object here is itself a CallExpression, not a bare identifier path. */
export function findThenCalls(root: ts.Node, baseCallee: string): ts.CallExpression[] {
  return findAll(root, ts.isCallExpression).filter((call) => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'then') return false
    const obj = call.expression.expression
    return ts.isCallExpression(obj) && flattenPropertyAccess(obj.expression) === baseCallee
  })
}
