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
 *  Each result is paired with whether its declaration list is `const`.
 *
 *  Wave 5, N5c: a destructuring pattern declares names too. `const { outcome }
 *  = something` shadowed the awaited result while an identifier-only filter
 *  saw no second declaration at all, so the trace back to the IPC call
 *  described a value the call never returned. A binding pattern counts when
 *  one of its binding elements BINDS `name` — `const { a: outcome }` does,
 *  `const { outcome: a }` does not, since the latter introduces `a`. */
export function findDeclarationsOf(root: ts.Node, name: string): { declaration: ts.VariableDeclaration; isConst: boolean }[] {
  const binds = (target: ts.BindingName): boolean => {
    if (ts.isIdentifier(target)) return target.text === name
    return findAll(target, ts.isBindingElement).some(
      (element) => ts.isIdentifier(element.name) && element.name.text === name
    )
  }
  return findAll(root, ts.isVariableDeclaration)
    .filter((decl) => binds(decl.name))
    .map((declaration) => {
      const list = declaration.parent
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
      return { declaration, isConst }
    })
}

/** Every real assignment whose left-hand side is exactly `left`, anywhere
 *  under `root` (compound assignments like `x += 1` included).
 *
 *  Wave 6, F-9: this used to compare the left-hand side's TEXT, and ten
 *  mutations walked straight past it — `shownWorkspace['current'] = …`,
 *  `(shownWorkspace.current) = …`, `;[shownWorkspace.current] = […]`,
 *  `Object.assign(shownWorkspace, …)`, an alias of the ref. Writes are
 *  found by their POSITION now (see `findWritesTo`), and a ref is inspected
 *  by every mention of its binding (see `findRefUses`), so the shape of the
 *  write no longer decides whether it counts. */
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken
])

/** The wrappers that change nothing about what an expression IS: they
 *  carry a type through, or a pair of brackets, and the thing underneath is
 *  still the same target and still the same value.
 *
 *  Wave 7, F-9 (X10, X11): `satisfies` was missing, so
 *  `(shownWorkspace.current satisfies string | null) = workspaceId`
 *  compiled, wrote the ref, and no write was seen. */
const isWrapper = (node: ts.Node): boolean =>
  ts.isParenthesizedExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isTypeAssertionExpression(node)

/** Climbs OUT of those wrappers, from a node to the outermost one that
 *  still means it: `(x.y) = 1` writes to `x.y`. */
function outOfWrappers(node: ts.Node): ts.Node {
  let current = node
  while (current.parent !== undefined && isWrapper(current.parent)) current = current.parent
  return current
}

/** Climbs IN through the same wrappers, from an expression to the thing it
 *  really is. */
function intoWrappers(node: ts.Expression): ts.Expression {
  let current = node
  while (isWrapper(current)) current = (current as ts.ParenthesizedExpression).expression
  return current
}

/** True when `node` sits where a value is WRITTEN rather than read: the
 *  left of any assignment operator, the operand of `++`/`--`, the target of
 *  `delete`, a `for (… of/in …)` binding, or an element/property of a
 *  destructuring pattern that is itself being assigned to.
 *
 *  Wave 6, F-9 (F8): `;[shownWorkspace.current] = [workspaceId]` is an
 *  ordinary destructuring assignment whose left-hand-side text is
 *  `[shownWorkspace.current]`, so no text comparison could ever see it. */
export function isWriteTarget(node: ts.Node): boolean {
  const target = outOfWrappers(node)
  const parent = target.parent
  if (parent === undefined) return false
  if (ts.isBinaryExpression(parent)) {
    return ASSIGNMENT_OPERATORS.has(parent.operatorToken.kind) && parent.left === target
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken
  }
  if (ts.isDeleteExpression(parent)) return true
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === target) return true
  // Inside a destructuring pattern: the pattern as a whole decides.
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    // Wave 7, F-9 (X4): `({ ...(shownWorkspace.current as any) } = {})` is
    // an object-spread ASSIGNMENT target, a different node kind from the
    // array spread beside it, and it wrote the ref unseen.
    ts.isSpreadAssignment(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent)
  ) {
    return isWriteTarget(parent)
  }
  return false
}

/** Every node under `root` that is WRITTEN TO and whose own text (ignoring
 *  wrappers) is `target`. Replaces the old left-hand-side text comparison:
 *  the write's shape no longer decides whether it is seen. */
export function findWritesTo(root: ts.Node, target: string): ts.Node[] {
  return findAll(root, (n): n is ts.Expression => ts.isExpression(n))
    .filter((node) => node.getText() === target && isWriteTarget(node))
}

/** How a React ref binding is used, by MENTION of the binding rather than
 *  by the text of any expression containing it.
 *
 *  Wave 6, F-9: the assertion that `shownWorkspace.current` is written in
 *  exactly one place is the hinge both workspace-drop guards hang from, and
 *  six separate mutations routed around it — five by writing through a
 *  spelling the text comparison did not recognise, one (`const alias =
 *  shownWorkspace`) by never mentioning `.current` at all. Every identifier
 *  with the ref's name is classified here instead:
 *
 *  - `writes`: a `ref.current` in a write position.
 *  - `reads`: a `ref.current` being read.
 *  - `escapes`: every other mention — a bracket access, the ref passed as a
 *    value, aliased, spread, or named as somebody's property. A ref that
 *    escapes can be written anywhere, so the count of `writes` would stop
 *    meaning anything.
 *
 *  Identity is by NAME, deliberately: a shadow declaring a second
 *  `shownWorkspace` is itself something this file must not contain, and
 *  counting its mentions too is the stricter answer. Only the binding's own
 *  declaration name is excluded. */
export interface RefUses {
  writes: ts.PropertyAccessExpression[]
  reads: ts.PropertyAccessExpression[]
  escapes: ts.Identifier[]
}

export function findRefUses(source: ts.SourceFile, refName: string, property = 'current'): RefUses {
  const uses: RefUses = { writes: [], reads: [], escapes: [] }
  for (const id of findIdentifiers(source, refName)) {
    const parent = id.parent
    // The `const shownWorkspace = useRef(...)` binding itself.
    if (parent !== undefined && ts.isVariableDeclaration(parent) && parent.name === id) continue
    if (
      parent !== undefined &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === id &&
      parent.name.text === property
    ) {
      if (isWriteTarget(parent)) uses.writes.push(parent)
      else uses.reads.push(parent)
      continue
    }
    uses.escapes.push(id)
  }
  return uses
}

/** True iff `node` is the entire expression of a statement that `fn`'s body
 *  runs directly, with nothing ahead of it that could decide not to run it.
 *
 *  Wave 6, F-9 (F4, F11): "the effect clears the message somewhere" was
 *  satisfied by `if (cancelled) setMessage(null)` — a clear that does not
 *  happen on a workspace switch — and by an early `return` placed above the
 *  clear. Preceding statements may therefore only be plain expression or
 *  variable statements: an `if`, a `return`, a loop or a `try` ahead of it
 *  all mean the clear is conditional. */
export function isUnconditionalLeadingStatement(fn: ts.Node, node: ts.Node): boolean {
  if (!isFunctionLike(fn)) return false
  const body = (fn as ts.ArrowFunction).body as ts.Node | undefined
  if (body === undefined || !ts.isBlock(body)) return false
  const index = body.statements.findIndex((statement) => isWithin(node, statement))
  if (index < 0) return false
  const statement = body.statements[index]
  if (!ts.isExpressionStatement(statement) || statement.expression !== node) return false
  return body.statements
    .slice(0, index)
    .every((earlier) => ts.isVariableStatement(earlier) || ts.isExpressionStatement(earlier))
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

/** Every property key a destructuring pattern binds MORE THAN ONCE, looking
 *  into nested patterns as well.
 *
 *  Wave 7, F-9 (X5): `const { 0: message, 1: setMessage, 1: say } =
 *  useState(…)` is legal, compiles, and binds the state setter to two
 *  names — so `say('…')` called from a handler puts an unguarded message on
 *  screen while every check keyed on the NAME `setMessage` stays green. One
 *  slot of a useState tuple may be bound once; a second name for it is an
 *  alias by another route. */
export function duplicateBoundKeys(name: ts.BindingName): string[] {
  if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) return []
  const counts = new Map<string, number>()
  const duplicates: string[] = []
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      const key = element.propertyName?.getText() ?? element.name.getText()
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (counts.get(key) === 2) duplicates.push(key)
    }
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) duplicates.push(...duplicateBoundKeys(element.name))
  }
  return duplicates
}

/** The operators whose result is one operand or the other, untouched. */
const SHORT_CIRCUIT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken
])

/** True when the VALUE of `expr` can actually differ according to the
 *  nodes in `carriers` — not merely when one of them is mentioned
 *  somewhere inside it.
 *
 *  Wave 7, F-9 (X1, X2): "the reported message mentions the outcome" was
 *  satisfied by `report(outcome.ok ? 'Lane synced' : 'Lane synced')` and by
 *  `report(outcome && 'Lane synced')`, both of which announce success for a
 *  sync that CONFLICTED — the very regression F5 was raised to close, back
 *  again with the outcome named but not used. Mentioning is not using, so
 *  each expression form is asked what its value can be:
 *
 *  - a conditional chooses between its arms, so identical arms report the
 *    same thing whatever happened, and one of the arms (or the condition
 *    that picks between them) must carry the result;
 *  - `&&`, `||` and `??` return one operand or the other, so BOTH have to
 *    carry it;
 *  - a template varies if one of its substitutions does;
 *  - a call varies if it is handed something that varies (that is the
 *    `describeOutcome(await …)` shape);
 *  - anything else varies if it contains a carrier at all. */
export function valueVariesWith(expr: ts.Expression, carriers: ReadonlySet<ts.Node>): boolean {
  const carried = (node: ts.Node): boolean => {
    for (const carrier of carriers) {
      if (isWithin(carrier, node)) return true
    }
    return false
  }
  const varies = (node: ts.Expression): boolean => {
    const e = intoWrappers(node)
    if (ts.isConditionalExpression(e)) {
      if (intoWrappers(e.whenTrue).getText() === intoWrappers(e.whenFalse).getText()) return false
      return carried(e.condition) || varies(e.whenTrue) || varies(e.whenFalse)
    }
    if (ts.isBinaryExpression(e) && SHORT_CIRCUIT_OPERATORS.has(e.operatorToken.kind)) {
      return varies(e.left) && varies(e.right)
    }
    if (ts.isTemplateExpression(e)) return e.templateSpans.some((span) => varies(span.expression))
    if (ts.isCallExpression(e)) {
      return carried(e.expression) || e.arguments.some((argument) => varies(argument))
    }
    return carried(e)
  }
  return varies(expr)
}
