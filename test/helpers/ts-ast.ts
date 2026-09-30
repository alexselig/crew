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

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
}

/** Like `findCallsTo`, but never descends into a nested function body.
 *
 *  Re-review m-5: `findCallsTo(tryStatement.tryBlock, …)` also matches a
 *  call sitting inside a closure that the try block merely DEFINES and
 *  never runs — so the real, awaited call could be moved outside the
 *  try/catch entirely (resurrecting the unhandled rejection those tests
 *  exist to prevent) while a dead `const unused = () => window.crew.publishLane(...)`
 *  left behind inside it kept the assertion green. Only a call actually
 *  executed by `root` itself counts here. */
export function findDirectCallsTo(root: ts.Node, calleeText: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionLike(node)) return
    if (ts.isCallExpression(node) && flattenPropertyAccess(node.expression) === calleeText) out.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return out
}

/** The dependency-array element texts of `const name = useCallback(fn, [deps])`,
 *  or undefined when `name` is not a useCallback with an array literal
 *  second argument. Re-review I-3: a hook whose deps omit `workspaceId`
 *  keeps the FIRST workspace's closure alive forever, so after a switch the
 *  panel's buttons act on the old workspace — invisible to any assertion
 *  that only inspects the handler body. */
export function findCallbackDependencies(source: ts.SourceFile, name: string): string[] | undefined {
  const decl = findAll(source, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === name)
  const init = decl?.initializer
  if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression)) return undefined
  if (init.expression.text !== 'useCallback') return undefined
  const deps = init.arguments[1]
  if (!deps || !ts.isArrayLiteralExpression(deps)) return undefined
  return deps.elements.map((el) => el.getText())
}

/** The dependency-array element texts of every `useEffect(fn, [deps])` in
 *  the file (one entry per effect; undefined for an effect with no array
 *  literal deps). */
export function findEffectDependencies(source: ts.SourceFile): (string[] | undefined)[] {
  return findAll(source, ts.isCallExpression)
    .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'useEffect')
    .map((call) => {
      const deps = call.arguments[1]
      return deps && ts.isArrayLiteralExpression(deps) ? deps.elements.map((el) => el.getText()) : undefined
    })
}

/** The nearest enclosing `if` statement whose THEN branch actually contains
 *  `node` — the real-AST way to ask "is this call guarded?", as opposed to
 *  checking that a comparison appears somewhere in the same function. */
export function enclosingIfStatement(node: ts.Node): ts.IfStatement | undefined {
  let current: ts.Node = node
  while (current.parent) {
    const parent = current.parent
    if (ts.isIfStatement(parent) && parent.thenStatement === current) return parent
    current = parent
  }
  return undefined
}

/** Flattens a `a && b && c` chain into its operand expressions (a single
 *  non-`&&` expression flattens to itself). */
export function logicalAndOperands(expr: ts.Expression): ts.Expression[] {
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...logicalAndOperands(expr.left), ...logicalAndOperands(expr.right)]
  }
  if (ts.isParenthesizedExpression(expr)) return logicalAndOperands(expr.expression)
  return [expr]
}

/** True when `operands` contains a real `left === right` comparison. */
export function hasStrictEqualityOperand(
  operands: readonly ts.Expression[],
  left: string,
  right: string
): boolean {
  return operands.some((operand) =>
    ts.isBinaryExpression(operand) &&
    operand.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operand.left.getText() === left &&
    operand.right.getText() === right)
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

/** Every `useEffect(fn, deps)` call in the file, in source order — the
 *  companion to `findEffectDependencies`, which returns only their deps.
 *  Wave 3 finding 1: an assertion about a deps array proves nothing about
 *  what the effect's BODY does, and the I-4 fix lives in that body. */
export function findEffectCalls(source: ts.SourceFile): ts.CallExpression[] {
  return findAll(source, ts.isCallExpression)
    .filter((call) => ts.isIdentifier(call.expression) && call.expression.text === 'useEffect')
}

/** The initializer of `const name = <hookName>(...)`, or undefined when
 *  `name` is not declared from a call to that hook. Real call identity: a
 *  comment or a string literal naming `useRef` is not a CallExpression. */
export function findHookCall(source: ts.SourceFile, name: string, hookName: string): ts.CallExpression | undefined {
  const decl = findAll(source, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === name)
  const init = decl?.initializer
  if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === hookName) {
    return init
  }
  return undefined
}

/** True iff `root` ITSELF executes a real assignment `left = right` — never
 *  one sitting in a nested function that `root` merely defines, and never a
 *  comment or string literal with the same text. Wave 3 finding 1: the
 *  workspace-tracking ref is only correct if the statement that updates it
 *  actually runs in the effect that fires on a workspace change. */
export function hasDirectAssignment(root: ts.Node, left: string, right: string): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (node !== root && isFunctionLike(node)) return
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.left.getText() === left &&
      node.right.getText() === right
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

/** True iff the FIRST statement a function body runs is the assignment
 *  `left = right`. Wave 4 finding F-3: "the effect assigns the ref somewhere"
 *  still passes when an early return, an await, or a guard runs first and the
 *  assignment never happens for the workspace the user just switched to. The
 *  ref's whole job is to record which workspace the panel is showing, so it
 *  has to be recorded before anything can decide not to. */
export function firstStatementAssigns(fn: ts.Node, left: string, right: string): boolean {
  if (!isFunctionLike(fn)) return false
  const body = (fn as ts.ArrowFunction).body as ts.Node | undefined
  if (body === undefined || !ts.isBlock(body)) return false
  const first = body.statements[0]
  if (first === undefined || !ts.isExpressionStatement(first)) return false
  const expr = first.expression
  return (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    expr.left.getText() === left &&
    expr.right.getText() === right
  )
}

/** Every real identifier named `name` under `root` — declarations, reads and
 *  property names alike are Identifier nodes, so a caller that wants only
 *  some of them filters by position. Text inside a comment or a string is not
 *  an Identifier and never appears here. */
export function findIdentifiers(root: ts.Node, name: string): ts.Identifier[] {
  return findAll(root, ts.isIdentifier).filter((id) => id.text === name)
}

/** True iff `node` is `ancestor` or sits inside it. Used to confine a
 *  sensitive identifier to the places allowed to mention it. */
export function isWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node
  while (current !== undefined) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
}

/** The `const [a, setA] = useState(...)` declaration that binds `name`, or
 *  undefined when `name` is not a useState binding. */
export function findUseStateDeclaration(source: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
  return findAll(source, ts.isVariableDeclaration).find((decl) => {
    const init = decl.initializer
    if (init === undefined || !ts.isCallExpression(init)) return false
    if (!ts.isIdentifier(init.expression) || init.expression.text !== 'useState') return false
    return findIdentifiers(decl.name, name).length > 0
  })
}

/** Every `const`/`let`/`var` declaration of `name` that `root` itself
 *  introduces, INCLUDING ones in nested blocks and nested functions — the
 *  point is to catch a shadow, so nested scopes are exactly what we want.
 *  Each result is paired with whether its declaration list is `const`. */
export function findDeclarationsOf(root: ts.Node, name: string): { declaration: ts.VariableDeclaration; isConst: boolean }[] {
  return findAll(root, ts.isVariableDeclaration)
    .filter((decl) => ts.isIdentifier(decl.name) && decl.name.text === name)
    .map((declaration) => {
      const list = declaration.parent
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
      return { declaration, isConst }
    })
}

/** Every real assignment whose left-hand side is exactly `left`, anywhere
 *  under `root` (compound assignments like `x += 1` included). */
export function findAssignmentsTo(root: ts.Node, left: string): ts.BinaryExpression[] {
  const assignmentKinds = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.PlusEqualsToken,
    ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ])
  return findAll(root, ts.isBinaryExpression).filter(
    (expr) => assignmentKinds.has(expr.operatorToken.kind) && expr.left.getText() === left,
  )
}

/** Resolves an argument to the awaited call whose RESULT it carries: either
 *  `f(await call())` given directly, or `const x = await call(); f(x)` where
 *  `x` is declared inside `root`. Returns undefined for a literal, a
 *  differently-named variable, or anything else.
 *
 *  Wave 3 finding 4: asserting only that an argument is spelled `outcome`
 *  passes when the real IPC call's result is thrown away and some unrelated
 *  `outcome` is described instead — the panel would then report an
 *  acknowledgement that never happened. Following the dataflow back to the
 *  call is what makes such an assertion load-bearing. */
export function resolveAwaitedCall(root: ts.Node, argument: ts.Expression): ts.CallExpression | undefined {
  const unwrap = (expr: ts.Expression): ts.CallExpression | undefined => {
    if (ts.isAwaitExpression(expr) && ts.isCallExpression(expr.expression)) return expr.expression
    return undefined
  }
  const direct = unwrap(argument)
  if (direct) return direct
  if (!ts.isIdentifier(argument)) return undefined
  const name = argument.text
  const decl = findAll(root, ts.isVariableDeclaration)
    .find((d) => ts.isIdentifier(d.name) && d.name.text === name)
  const init = decl?.initializer
  return init ? unwrap(init) : undefined
}
