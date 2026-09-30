// ConductorPanel.tsx is a React component; under vitest's node-only config
// there is no DOM to mount it in. Its pure decision logic already lives in
// conductor-view-model.ts (conductorPanelMode/describeUnexpectedFailure,
// covered directly in conductor-view-model.test.ts). What is left to pin
// here is the WIRING itself — that publish/sync actually reach those pure
// functions inside a try/catch, and that a rejection always re-fetches the
// real snapshot in a `finally` so a stale "publishing" lock can never
// outlive the promise that set it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/renderer/components/ConductorPanel.tsx', 'utf8')

function functionBody(name: string): string {
  const start = source.indexOf(`const ${name} = useCallback`)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('}, [])', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('ConductorPanel — publish/sync never leave an unhandled rejection', () => {
  it('wraps publish in try/catch, using describeUnexpectedFailure for the rejection', () => {
    const body = functionBody('publish')
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/catch\s*\(error\)\s*\{/)
    expect(body).toContain("describeUnexpectedFailure('publish', error)")
  })

  it('wraps sync in try/catch, using describeUnexpectedFailure for the rejection', () => {
    const body = functionBody('sync')
    expect(body).toMatch(/try\s*\{/)
    expect(body).toMatch(/catch\s*\(error\)\s*\{/)
    expect(body).toContain("describeUnexpectedFailure('sync', error)")
  })

  it('refreshes the snapshot from getConductorState() in a finally, on both handlers', () => {
    // Load-bearing against the actual bug this bullet targets: without this,
    // a rejection that happens after the backend already broadcast
    // `publishing: laneId` (but before any broadcast clears it) leaves the
    // panel trusting that stale lock forever — the try/catch alone only
    // stops the rejection from being unhandled, it does not un-stick the UI.
    const publishBody = functionBody('publish')
    const syncBody = functionBody('sync')
    for (const body of [publishBody, syncBody]) {
      expect(body).toMatch(/finally\s*\{/)
      const finallyIndex = body.indexOf('finally')
      expect(body.slice(finallyIndex)).toContain('window.crew.getConductorState().then(setSnapshot)')
    }
  })

  it('imports describeUnexpectedFailure from the pure view-model, not a local copy', () => {
    expect(source).toMatch(/import\s*\{[^}]*describeUnexpectedFailure[^}]*\}\s*from\s*'\.\.\/conductor-view-model'/)
  })
})
