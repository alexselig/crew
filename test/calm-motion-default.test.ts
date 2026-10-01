// The main process owns the real default (DEFAULT_SETTINGS.calmMotion), but
// App.tsx must supply its own fallback for the frames before settings arrive
// over IPC. If the two disagree, the first paint starts on the lively bob and
// then swaps the moment settings land — a visible flash on every launch, and
// precisely the jitter this default was flipped to remove.
//
// Nothing else covers that fallback: the renderer browser fixture pins
// `calmMotion: false` explicitly (by design — it exercises the off→on swap),
// so reverting `?? true` to `?? false` otherwise passes the entire suite.
//
// This reads the AST rather than the text, following conductor-app-mount's
// reasoning: a comment or string literal containing `?? true` is not a
// QuestionQuestionToken whose right operand is a TrueKeyword, and cannot
// satisfy this check.
import * as ts from 'typescript'
import { describe, it, expect } from 'vitest'
import { parseSource, findCallsTo } from './helpers/ts-ast'
import { DEFAULT_SETTINGS } from '../src/main/store'

describe('calm working animation — default', () => {
  it("App.tsx's pre-settings fallback is the same value as DEFAULT_SETTINGS.calmMotion", () => {
    const source = parseSource('src/renderer/App.tsx')
    const calls = findCallsTo(source, 'useCalmMotion')
    expect(calls).toHaveLength(1)

    const arg = calls[0].arguments[0]
    expect(arg, 'useCalmMotion must be called with an argument').toBeDefined()
    expect(
      ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken,
      'the argument must be a `??` expression supplying a fallback'
    ).toBe(true)

    const fallback = (arg as ts.BinaryExpression).right
    const fallbackValue =
      fallback.kind === ts.SyntaxKind.TrueKeyword
        ? true
        : fallback.kind === ts.SyntaxKind.FalseKeyword
          ? false
          : null

    expect(fallbackValue, 'the fallback must be a boolean literal').not.toBeNull()
    expect(fallbackValue).toBe(DEFAULT_SETTINGS.calmMotion)
  })
})
