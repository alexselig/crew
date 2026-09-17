# Task 3 Report — Pause Renderer Polling and Share the Elapsed-Time Clock

## Outcome

Implemented the renderer-side activity-aware polling and shared elapsed-time clock required by Task 3 in `/Users/alexselig/crew/.worktrees/custom-views` without changing the app version or adding dependencies.

## RED Evidence

Command:

```bash
npm test -- --run test/activity-poller.test.ts test/now-clock.test.ts
```

Result:

- `test/activity-poller.test.ts` failed because `src/renderer/activity-poller.ts` did not exist.
- `test/now-clock.test.ts` failed because `src/renderer/now-clock.ts` did not exist.

This established the missing poller and shared-clock primitives before implementation.

## GREEN Evidence

Command:

```bash
npm test -- --run test/activity-poller.test.ts test/now-clock.test.ts test/renderer-app-activity.test.ts && npm run typecheck
```

Result:

- `test/activity-poller.test.ts`: **PASS** (`4` tests)
- `test/now-clock.test.ts`: **PASS** (`2` tests)
- `test/renderer-app-activity.test.ts`: **PASS** (`2` tests)
- `npm run typecheck`: **PASS** (`tsconfig.node.json` and `tsconfig.web.json`)

## Files Changed

- `src/renderer/activity-poller.ts`
- `src/renderer/now-clock.ts`
- `src/renderer/app-activity.tsx`
- `src/renderer/components/TerminalPreview.tsx`
- `src/renderer/components/TranscriptPane.tsx`
- `src/renderer/components/Since.tsx`
- `test/activity-poller.test.ts`
- `test/now-clock.test.ts`
- `test/renderer-app-activity.test.ts`

## Implementation Notes

- Added `createActivityPoller()` with a persistent in-flight guard, immediate activation refresh, interval ownership, queued single resume refresh, and disposal-safe shutdown semantics.
- Added `now-clock.ts` as a shared `useSyncExternalStore` clock with one interval across subscribers and explicit `setNowClockActive()` control.
- Wired the now-clock synchronizer into `applyAppActivity(...)` before React state publication, preserving the synchronous resource-order guarantee from Task 2.
- Moved `TerminalPreview` and `TranscriptPane` from raw `setInterval()` usage onto `ActivityPoller`, with the transcript poller's stateful guard surviving deactivate/reactivate transitions.
- Kept `TranscriptPane`'s transcript version token, source-selection state (`usingAgent`), signature cache, and polling function inside the `[sessionId, agentSessionId]` effect so they survive app activity changes.
- Replaced per-instance `Since` timers with the shared activity-aware `useNow()` clock.

## Self-Review

- Confirmed the app version remains `0.6.0`.
- Confirmed no dependency manifests changed and no new dependencies were added.
- Checked the transcript effect dependencies to ensure app activity changes do not recreate the version/signature/source-selection state.
- Fixed one implementation issue found during GREEN validation: the poller originally deferred `run()` via `Promise.resolve().then(run)`, which missed the required queued-resume behavior under the provided fake-timer test. Updating it to invoke `run()` synchronously while still normalizing completion with `Promise.resolve(run())` satisfied the requirement and preserved overlap protection.
- Ran `git diff --check` with no whitespace or patch formatting issues.

## Concerns

- Focused coverage now verifies the new shared primitives and app-activity ordering directly, but there is still no dedicated rendered-component regression test asserting `TerminalPreview`, `TranscriptPane`, and `Since` wiring together under React activity transitions. The current task brief did not require adding that broader integration coverage.
