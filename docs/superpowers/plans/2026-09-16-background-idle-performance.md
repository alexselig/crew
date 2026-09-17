# Background Idle Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Crew inexpensive whenever no Crew window is focused while preserving live sessions, needs-you detection, notifications, and recent terminal output on return.

**Architecture:** Electron main owns one global any-window-focused state and publishes typed changes to every renderer. Each renderer uses one activity provider to suspend both terminal pools, stop shared UI pollers/clocks, and apply an inactive CSS class; PTYs and main-process detection remain live, while terminal output continues into bounded dormant replay tails.

**Tech Stack:** Electron 31, React 18, TypeScript 5.5, xterm 5.5, Vitest 2 with fake timers.

## Global Constraints

- Keep `package.json` version at `0.6.0`; do not publish or release.
- Do not add dependencies.
- Default renderer activity to active until main reports otherwise.
- Activity is global: one focused Crew window keeps all Crew renderers active.
- Do not pause PTYs, state detection, notifications, transcript parsing, cost parsing, Project Tracker, asset watchers, or app webviews.
- Preserve the existing 64 KiB terminal replay-tail bound and terminal tombstone behavior.
- Do not launch unsigned Crew, Electron, Playwright, or GUI E2E on this host.
- Performance acceptance must use an already-installed signed app or a Developer ID-signed build.

---

### Task 1: Typed Global Application Activity

**Files:**
- Create: `src/main/app-activity.ts`
- Create: `src/preload/replay-value.ts`
- Create: `src/renderer/app-activity.tsx`
- Create: `test/app-activity.test.ts`
- Create: `test/replay-value.test.ts`
- Modify: `src/main/index.ts:132-143,201-289`
- Modify: `src/shared/types.ts:350-364`
- Modify: `src/shared/api.ts:198-219`
- Modify: `src/preload/index.ts:90-103`
- Modify: `src/renderer/main.tsx:1-11`
- Modify: `src/renderer/__tests__/custom-view-renderer-integration-fixture.tsx:95-276`

**Interfaces:**
- Produces: `AppActivityCoordinator<W extends FocusableWindow>`.
- Produces: `ReplayValue<T>`, installed eagerly by preload before React starts.
- Produces: `useAppActivity(): boolean`, defaulting to `true`.
- Produces: `AppActivityProvider`, which subscribes once to `window.crew.onAppActivity`.
- Produces: `CrewAPI.onAppActivity(cb: (active: boolean) => void): Unsubscribe`.
- Consumes in Task 2: `setTerminalRenderingActive(active: boolean): void`, called by the provider once Task 2 adds it.
- Consumes in Task 3: `setNowClockActive(active: boolean): void`, called by the provider once Task 3 adds it.

- [ ] **Step 1: Write the failing coordinator tests**

Create `test/app-activity.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppActivityCoordinator } from '../src/main/app-activity'

interface FakeWindow {
  focused: boolean
  isFocused(): boolean
}

describe('AppActivityCoordinator', () => {
  let windows: FakeWindow[]
  let sent: boolean[]
  let queued: (() => void)[]
  let coordinator: AppActivityCoordinator<FakeWindow>

  beforeEach(() => {
    windows = []
    sent = []
    queued = []
    coordinator = new AppActivityCoordinator(
      () => windows,
      (active) => sent.push(active),
      (run) => queued.push(run)
    )
  })

  it('reports inactive when no Crew window is focused', () => {
    windows = [{ focused: false, isFocused() { return this.focused } }]
    coordinator.recompute()
    expect(sent).toEqual([false])
  })

  it('reports active when any Crew window is focused', () => {
    windows = [
      { focused: false, isFocused() { return this.focused } },
      { focused: true, isFocused() { return this.focused } }
    ]
    coordinator.recompute()
    expect(sent).toEqual([true])
  })

  it('does not rebroadcast an unchanged state', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    coordinator.recompute()
    coordinator.recompute()
    expect(sent).toEqual([true])
  })

  it('coalesces adjacent lifecycle events before recomputing', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    coordinator.schedule()
    coordinator.schedule()
    expect(queued).toHaveLength(1)
    windows[0].focused = false
    queued[0]()
    expect(sent).toEqual([false])
  })

  it('does not emit inactive while focus transfers between Crew windows', () => {
    windows = [
      { focused: true, isFocused() { return this.focused } },
      { focused: false, isFocused() { return this.focused } }
    ]
    coordinator.recompute()
    sent.length = 0

    windows[0].focused = false
    coordinator.schedule()
    windows[1].focused = true
    coordinator.schedule()
    queued[0]()

    expect(sent).toEqual([])
  })

  it('sends the current state directly to a newly ready renderer', () => {
    windows = [{ focused: true, isFocused() { return this.focused } }]
    const ready = vi.fn()
    coordinator.sendCurrent(ready)
    expect(ready).toHaveBeenCalledWith(true)
    expect(sent).toEqual([])
  })
})
```

- [ ] **Step 2: Write the failing preload replay test**

Create `test/replay-value.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { ReplayValue } from '../src/preload/replay-value'

describe('ReplayValue', () => {
  it('replays a value published before the renderer subscribes', () => {
    const value = new ReplayValue(true)
    value.publish(false)
    const listener = vi.fn()

    const unsubscribe = value.subscribe(listener)

    expect(listener).toHaveBeenCalledWith(false)
    unsubscribe()
  })

  it('publishes later values once and removes unsubscribed listeners', () => {
    const value = new ReplayValue(true)
    const listener = vi.fn()
    const unsubscribe = value.subscribe(listener)
    listener.mockClear()

    value.publish(false)
    unsubscribe()
    value.publish(true)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(false)
  })
})
```

- [ ] **Step 3: Run the coordinator and replay tests to verify they fail**

Run: `npm test -- --run test/app-activity.test.ts test/replay-value.test.ts`

Expected: FAIL because `src/main/app-activity.ts` and `src/preload/replay-value.ts` do not exist.

- [ ] **Step 4: Implement the pure coordinator**

Create `src/main/app-activity.ts`:

```ts
export interface FocusableWindow {
  isFocused(): boolean
}

type Defer = (run: () => void) => void

export class AppActivityCoordinator<W extends FocusableWindow> {
  private last: boolean | undefined
  private scheduled = false

  constructor(
    private readonly windows: () => readonly W[],
    private readonly broadcast: (active: boolean) => void,
    private readonly defer: Defer = queueMicrotask
  ) {}

  current(): boolean {
    return this.windows().some((window) => window.isFocused())
  }

  recompute(): void {
    const active = this.current()
    if (active === this.last) return
    this.last = active
    this.broadcast(active)
  }

  schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.defer(() => {
      this.scheduled = false
      this.recompute()
    })
  }

  sendCurrent(send: (active: boolean) => void): void {
    send(this.current())
  }
}
```

The deferred recompute prevents a momentary inactive broadcast when focus moves directly between two Crew windows and Electron emits `blur` before `focus`.

- [ ] **Step 5: Implement eager preload replay**

Create `src/preload/replay-value.ts`:

```ts
export class ReplayValue<T> {
  private readonly listeners = new Set<(value: T) => void>()

  constructor(private value: T) {}

  publish(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener(value)
  }

  subscribe(listener: (value: T) => void): () => void {
    listener(this.value)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
```

- [ ] **Step 6: Wire the coordinator through Electron IPC**

In `src/shared/types.ts`, add:

```ts
EVT_APP_ACTIVITY: 'evt:appActivity',
```

In `src/shared/api.ts`, add:

```ts
/** Whether any Crew window is currently focused. */
onAppActivity(cb: (active: boolean) => void): Unsubscribe
```

In `src/preload/index.ts`, install the activity listener at module evaluation time, before React can miss the initial main-process event:

```ts
import { ReplayValue } from './replay-value'

const appActivity = new ReplayValue(true)
ipcRenderer.on(IPC.EVT_APP_ACTIVITY, (_event, active: boolean) => appActivity.publish(active))
```

Expose the replaying subscription on `CrewAPI`:

```ts
onAppActivity: (cb) => appActivity.subscribe(cb),
```

In `src/main/index.ts`, import `AppActivityCoordinator`, create one module-level coordinator after `broadcast`, and retain `isCrewForeground()` for notification policy:

```ts
const appActivity = new AppActivityCoordinator(
  () => BrowserWindow.getAllWindows(),
  (active) => broadcast(IPC.EVT_APP_ACTIVITY, active)
)

function isCrewForeground(): boolean {
  return appActivity.current()
}
```

In `createWindow()`, register every relevant lifecycle event immediately after creating `w`:

```ts
for (const event of ['focus', 'blur', 'closed', 'show', 'hide', 'minimize', 'restore'] as const) {
  w.on(event, () => appActivity.schedule())
}
```

At the start of the existing `did-finish-load` callback, send the current value to that renderer even when the global state did not change:

```ts
appActivity.sendCurrent((active) => w.webContents.send(IPC.EVT_APP_ACTIVITY, active))
```

Add `onAppActivity: () => () => {}` to the typed `CrewAPI` test fixture in `src/renderer/__tests__/custom-view-renderer-integration-fixture.tsx`.

- [ ] **Step 7: Add the renderer provider with a safe active default**

Create `src/renderer/app-activity.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const AppActivityContext = createContext(true)

export function AppActivityProvider({ children }: { children: ReactNode }): JSX.Element {
  const [active, setActive] = useState(true)

  useEffect(() => window.crew.onAppActivity((next) => setActive(next)), [])

  useEffect(() => {
    document.documentElement.classList.toggle('crew-inactive', !active)
  }, [active])

  return <AppActivityContext.Provider value={active}>{children}</AppActivityContext.Provider>
}

export function useAppActivity(): boolean {
  return useContext(AppActivityContext)
}
```

Wrap `App` in `src/renderer/main.tsx`:

```tsx
import { AppActivityProvider } from './app-activity'

createRoot(root).render(
  <AppActivityProvider>
    <App />
  </AppActivityProvider>
)
```

Task 2 and Task 3 will extend the subscription callback with their two synchronous global setters. The eager preload replay closes the startup race; keeping the provider active by default still makes an unexpected IPC failure expensive rather than incorrect.

- [ ] **Step 8: Run focused validation**

Run: `npm test -- --run test/app-activity.test.ts test/replay-value.test.ts && npm run typecheck`

Expected: coordinator tests PASS and both TypeScript projects report no errors.

- [ ] **Step 9: Commit**

```bash
git add src/main/app-activity.ts src/main/index.ts src/preload/replay-value.ts src/shared/types.ts src/shared/api.ts src/preload/index.ts src/renderer/app-activity.tsx src/renderer/main.tsx src/renderer/__tests__/custom-view-renderer-integration-fixture.tsx test/app-activity.test.ts test/replay-value.test.ts
git commit -m "feat: publish global Crew activity"
```

---

### Task 2: Suspend Terminal Emulation While Inactive

**Files:**
- Modify: `src/renderer/terminal-pool.ts:35-48,91-177`
- Modify: `src/renderer/terminal/pool.ts:151-278,429-452`
- Modify: `src/renderer/terminal/facade.ts:15-37`
- Create: `src/renderer/app-activity-state.ts`
- Modify: `src/renderer/app-activity.tsx`
- Modify: `src/renderer/components/TerminalHost.tsx`
- Modify: `test/terminal-pool-bounded.test.ts`
- Create: `test/legacy-terminal-suspension.test.ts`
- Create: `test/renderer-app-activity.test.ts`

**Interfaces:**
- Produces in each pool: `setRenderingActive(active: boolean): void`.
- Produces in facade: `setTerminalRenderingActive(active: boolean): void`.
- Consumes: `useAppActivity(): boolean` from Task 1.
- Invariant: inactive `writeTo()` updates dormant state only and never calls `getPooled()`.

- [ ] **Step 1: Add failing enhanced-pool suspension tests**

Extend `test/terminal-pool-bounded.test.ts` imports with `setRenderingActive`, then add:

```ts
it('retires every live emulator when terminal rendering is suspended', () => {
  getPooled('visible')
  writeTo('background', 'before')
  expect(liveEngineCount()).toBe(2)

  setRenderingActive(false)

  expect(liveEngineCount()).toBe(0)
  expect(dormantCount()).toBe(2)
  expect(engines.every((engine) => engine.disposed)).toBe(true)
})

it('keeps parsing output without allocating while suspended', () => {
  setRenderingActive(false)
  writeTo('sleeping', CYCLE + 'recent output')

  expect(createXtermEngine).not.toHaveBeenCalled()
  expect(liveEngineCount()).toBe(0)
  expect(getBlocks('sleeping')).toHaveLength(1)
  expect(getTranscript('sleeping')).toHaveLength(1)
})

it('replays one bounded tail after resume without duplicating semantics', () => {
  setRenderingActive(false)
  writeTo('sleeping', CYCLE + 'recent output')
  setRenderingActive(true)

  const pooled = getPooled('sleeping')

  expect(asFake(pooled.engine).written.join('')).toContain('recent output')
  expect(getBlocks('sleeping')).toHaveLength(1)
  expect(liveEngineCount()).toBe(1)
})

it('keeps suspension idempotent and preserves tombstones', () => {
  getPooled('closed')
  setRenderingActive(false)
  setRenderingActive(false)
  disposePooled('closed')
  writeTo('closed', 'late output')
  setRenderingActive(true)

  expect(liveEngineCount()).toBe(0)
  expect(dormantCount()).toBe(0)
})
```

Ensure `resetPoolForTests()` resets activity to active so tests cannot leak suspension state.

- [ ] **Step 2: Add failing legacy-pool suspension tests**

Create `test/legacy-terminal-suspension.test.ts` with xterm and addon mocks following `test/webgl-budget.test.ts`. Assert the same resource invariants:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { terminals } = vi.hoisted(() => {
  const terminals: Array<{ written: string[]; disposed: boolean }> = []
  return { terminals }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element = null
    textarea = null
    buffer = { active: { length: 0, getLine: () => null } }
    cols = 80
    rows = 24
    written: string[] = []
    disposed = false
    constructor() { terminals.push(this) }
    loadAddon(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose() {} } }
    write(data: string): void { this.written.push(data) }
    dispose(): void { this.disposed = true }
    focus(): void {}
    registerMarker(): null { return null }
    registerDecoration(): null { return null }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('../src/renderer/preview-bus', () => ({ previewToken: vi.fn() }))

import {
  dormantTerminalCount,
  getPooled,
  liveTerminalCount,
  previewText,
  resetPoolForTests,
  setRenderingActive,
  writeTo
} from '../src/renderer/terminal-pool'

beforeEach(() => {
  resetPoolForTests()
  terminals.length = 0
  ;(globalThis as { window?: unknown }).window = { crew: { openExternal: vi.fn() } }
})

describe('legacy terminal suspension', () => {
  it('retires live terminals and does not allocate for background output', () => {
    getPooled('visible')
    setRenderingActive(false)
    writeTo('visible', 'recent')
    writeTo('new', 'background')

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(2)
    expect(terminals).toHaveLength(1)
    expect(terminals[0].disposed).toBe(true)
  })

  it('replays recent output only when the visible terminal is reacquired', () => {
    setRenderingActive(false)
    writeTo('sleeping', 'recent output')
    expect(previewText('sleeping')).toContain('recent output')
    expect(terminals).toHaveLength(0)

    setRenderingActive(true)
    const pooled = getPooled('sleeping')
    expect((pooled.term as unknown as { written: string[] }).written.join('')).toContain('recent output')
    expect(terminals).toHaveLength(1)
  })

  it('bounds one oversized dormant chunk without splitting Unicode', () => {
    setRenderingActive(false)
    const output = 'old🚀' + 'n'.repeat(TAIL_LIMIT + 20)
    writeTo('sleeping', output)

    expect(previewText('sleeping', TAIL_LIMIT).join('\n').length).toBeLessThanOrEqual(TAIL_LIMIT)
    setRenderingActive(true)
    const pooled = getPooled('sleeping')
    const replay = (pooled.term as unknown as { written: string[] }).written.join('')
    expect(replay).toBe(output.slice(-TAIL_LIMIT))
    expect(replay.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00)
  })

  it('keeps suspension idempotent and does not resurrect a tombstoned session', () => {
    getPooled('closed')
    setRenderingActive(false)
    setRenderingActive(false)
    disposePooled('closed')
    writeTo('closed', 'late output')
    setRenderingActive(true)

    expect(liveTerminalCount()).toBe(0)
    expect(dormantTerminalCount()).toBe(0)
  })
})
```

Include `TAIL_LIMIT` and `disposePooled` in this test's imports.

- [ ] **Step 3: Run suspension tests to verify they fail**

Run: `npm test -- --run test/terminal-pool-bounded.test.ts test/legacy-terminal-suspension.test.ts`

Expected: FAIL because neither pool exports `setRenderingActive`.

- [ ] **Step 4: Implement idempotent suspension in both pools**

In both pool modules, add:

```ts
let renderingActive = true

export function setRenderingActive(active: boolean): void {
  if (active === renderingActive) return
  renderingActive = active
  if (!active) {
    for (const id of [...pool.keys()]) retire(id)
  }
}
```

Replace the legacy pool's `pushTail()` with the enhanced pool's exact partial-chunk trimming algorithm so one oversized chunk is bounded and a UTF-16 surrogate pair cannot be split:

```ts
function pushTail(t: { tailParts: string[]; tailLen: number }, data: string): void {
  if (!data) return
  t.tailParts.push(data)
  t.tailLen += data.length
  if (t.tailLen <= TAIL_LIMIT) return
  while (t.tailLen - t.tailParts[0].length >= TAIL_LIMIT) {
    t.tailLen -= t.tailParts.shift()!.length
  }
  const trim = t.tailLen - TAIL_LIMIT
  t.tailParts[0] = t.tailParts[0].slice(trim)
  t.tailLen -= trim
  const first = t.tailParts[0].charCodeAt(0)
  if (first >= 0xdc00 && first <= 0xdfff) {
    t.tailParts[0] = t.tailParts[0].slice(1)
    t.tailLen--
    if (!t.tailParts[0]) t.tailParts.shift()
  }
}
```

In each `writeTo()`, immediately after the tombstone check, force inactive writes through dormant storage before looking up or allocating a live emulator:

```ts
if (!renderingActive) {
  let dormantSession = dormant.get(id)
  if (!dormantSession) {
    dormantSession = /* the module's existing empty dormant state */
    dormant.set(id, dormantSession)
  }
  /* use the module's existing bounded-tail/semantic ingest helper */
  return
}
```

For the legacy pool, create `{ tailParts: [], tailLen: 0, lastUsed: Date.now() }` and call `pushTail`.
For the enhanced pool, call `newSemantic()` and then `ingest(dormantSession, data, null)` so transcript and block parsing continue without an emulator.

Set `renderingActive = true` in each `resetPoolForTests()`.

- [ ] **Step 5: Add the facade setter and activity-aware terminal boundary**

In `src/renderer/terminal/facade.ts`:

```ts
export function setTerminalRenderingActive(active: boolean): void {
  legacy.setRenderingActive(active)
  crew.setRenderingActive(active)
}
```

In `src/renderer/app-activity.tsx`, import it and apply terminal state synchronously inside the replayed IPC callback, before publishing React state:

```tsx
useEffect(
  () =>
    window.crew.onAppActivity((next) => {
      setTerminalRenderingActive(next)
      setActive(next)
    }),
  []
)
```

In `src/renderer/components/TerminalHost.tsx`, use the provider as the only activity boundary:

```tsx
const active = useAppActivity()
if (!active) return <div className="term-mount term-mount--suspended" aria-hidden="true" />
```

The callback suspends both pools before React can process another output-rendering turn. On resume it enables allocation before React remounts the visible terminal. Returning a different tree unmounts `TerminalView`/`CrewTerminal`, runs their existing listener/observer cleanup, and lets the pool dispose the emulator. On resume the visible host mounts again, reacquires exactly one emulator, replays the tail, refits, and follows existing `focusOnMount` behavior.

Create the pure ordering helper in `src/renderer/app-activity-state.ts` so its
unit test does not import React or xterm:

```ts
export function applyAppActivity(
  next: boolean,
  synchronize: readonly ((active: boolean) => void)[],
  publish: (active: boolean) => void
): void {
  for (const sync of synchronize) sync(next)
  publish(next)
}
```

Use `applyAppActivity(next, [setTerminalRenderingActive], setActive)` in the subscription. Create `test/renderer-app-activity.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyAppActivity } from '../src/renderer/app-activity-state'

describe('applyAppActivity', () => {
  it('synchronizes resources before publishing React state', () => {
    const order: string[] = []
    const terminal = vi.fn(() => order.push('terminal'))
    const publish = vi.fn(() => order.push('publish'))

    applyAppActivity(false, [terminal], publish)

    expect(order).toEqual(['terminal', 'publish'])
    expect(terminal).toHaveBeenCalledWith(false)
    expect(publish).toHaveBeenCalledWith(false)
  })
})
```

Task 3 will add the clock synchronizer to the same array.

- [ ] **Step 6: Run focused validation**

Run: `npm test -- --run test/terminal-pool-bounded.test.ts test/legacy-terminal-suspension.test.ts test/renderer-app-activity.test.ts test/webgl-budget.test.ts && npm run typecheck`

Expected: all selected tests PASS and both TypeScript projects report no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/terminal-pool.ts src/renderer/terminal/pool.ts src/renderer/terminal/facade.ts src/renderer/app-activity-state.ts src/renderer/app-activity.tsx src/renderer/components/TerminalHost.tsx test/terminal-pool-bounded.test.ts test/legacy-terminal-suspension.test.ts test/renderer-app-activity.test.ts
git commit -m "perf: suspend terminal rendering in background"
```

---

### Task 3: Pause Renderer Polling and Share the Elapsed-Time Clock

**Files:**
- Create: `src/renderer/activity-poller.ts`
- Create: `src/renderer/now-clock.ts`
- Create: `test/activity-poller.test.ts`
- Create: `test/now-clock.test.ts`
- Modify: `src/renderer/app-activity.tsx`
- Modify: `src/renderer/components/TerminalPreview.tsx`
- Modify: `src/renderer/components/TranscriptPane.tsx:92-174`
- Modify: `src/renderer/components/Since.tsx`

**Interfaces:**
- Produces: `createActivityPoller(intervalMs: number, run: () => void | Promise<void>): ActivityPoller`.
- `ActivityPoller` exposes `setActive(active: boolean): void` and `dispose(): void`.
- Produces: `useNow(): number`.
- Produces: `setNowClockActive(active: boolean): void`.
- Guarantees: immediate refresh on activation, one interval per poller, no overlapping async calls across deactivate/reactivate transitions, one queued resume refresh after an outstanding request, and one shared one-second clock for all `Since` instances.

- [ ] **Step 1: Write failing poller tests**

Create `test/activity-poller.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityPoller } from '../src/renderer/activity-poller'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createActivityPoller', () => {
  it('does nothing while inactive', () => {
    const run = vi.fn()
    const poller = createActivityPoller(500, run)
    vi.advanceTimersByTime(2_000)
    expect(run).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    poller.dispose()
  })

  it('runs immediately and then on the requested interval', async () => {
    const run = vi.fn()
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.runAllTicks()
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(3)
    poller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues one resume refresh without overlapping a slow async run', async () => {
    let release: (() => void) | undefined
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(run).toHaveBeenCalledTimes(1)
    poller.setActive(false)
    poller.setActive(true)
    expect(run).toHaveBeenCalledTimes(1)
    release?.()
    await vi.runAllTicks()
    expect(run).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('stops permanently after disposal even if an outstanding run settles', async () => {
    let release: (() => void) | undefined
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const poller = createActivityPoller(500, run)
    poller.setActive(true)
    await vi.runAllTicks()
    poller.dispose()
    release?.()
    await vi.runAllTicks()
    vi.advanceTimersByTime(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Write failing shared-clock tests**

Create `test/now-clock.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getNowSnapshot,
  resetNowClockForTests,
  setNowClockActive,
  subscribeNow
} from '../src/renderer/now-clock'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  resetNowClockForTests()
})

afterEach(() => vi.useRealTimers())

describe('shared now clock', () => {
  it('uses one interval for multiple subscribers', () => {
    const a = vi.fn()
    const b = vi.fn()
    vi.setSystemTime(2_000)
    const stopA = subscribeNow(a)
    const stopB = subscribeNow(b)
    expect(getNowSnapshot()).toBe(2_000)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    stopA()
    stopB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops while inactive and emits a fresh timestamp on resume', () => {
    const listener = vi.fn()
    const stop = subscribeNow(listener)
    setNowClockActive(false)
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(9_000)
    setNowClockActive(true)
    expect(getNowSnapshot()).toBe(9_000)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    stop()
  })
})
```

- [ ] **Step 3: Run timer tests to verify they fail**

Run: `npm test -- --run test/activity-poller.test.ts test/now-clock.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 4: Implement the guarded activity poller**

Create `src/renderer/activity-poller.ts`:

```ts
export interface ActivityPoller {
  setActive(active: boolean): void
  dispose(): void
}

export function createActivityPoller(
  intervalMs: number,
  run: () => void | Promise<void>
): ActivityPoller {
  let active = false
  let disposed = false
  let inFlight = false
  let pending = false
  let timer: ReturnType<typeof setInterval> | undefined

  const tick = (): void => {
    if (disposed || !active) return
    if (inFlight) {
      pending = true
      return
    }
    inFlight = true
    void Promise.resolve()
      .then(run)
      .finally(() => {
        inFlight = false
        if (active && pending && !disposed) {
          pending = false
          tick()
        }
      })
  }

  return {
    setActive(next) {
      if (disposed || active === next) return
      active = next
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (!active) {
        pending = false
        return
      }
      tick()
      timer = setInterval(tick, intervalMs)
    },
    dispose() {
      disposed = true
      active = false
      pending = false
      if (timer) clearInterval(timer)
      timer = undefined
    }
  }
}
```

- [ ] **Step 5: Implement the shared clock**

Create `src/renderer/now-clock.ts`:

```ts
import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let active = true
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function emit(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

function reconcileTimer(): void {
  if (active && listeners.size > 0 && !timer) timer = setInterval(emit, 1000)
  if ((!active || listeners.size === 0) && timer) {
    clearInterval(timer)
    timer = undefined
  }
}

export function subscribeNow(listener: () => void): () => void {
  const first = listeners.size === 0
  listeners.add(listener)
  if (active && first) now = Date.now()
  reconcileTimer()
  return () => {
    listeners.delete(listener)
    reconcileTimer()
  }
}

export function getNowSnapshot(): number {
  return now
}

export function setNowClockActive(next: boolean): void {
  if (active === next) return
  active = next
  if (active) emit()
  reconcileTimer()
}

export function useNow(): number {
  return useSyncExternalStore(subscribeNow, getNowSnapshot, getNowSnapshot)
}

export function resetNowClockForTests(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  listeners.clear()
  active = true
  now = Date.now()
}
```

- [ ] **Step 6: Move preview, transcript, and Since onto the shared primitives**

In `src/renderer/app-activity.tsx`, add the shared clock to the synchronous transition from Task 2:

```tsx
applyAppActivity(next, [setTerminalRenderingActive, setNowClockActive], setActive)
```

Extend `test/renderer-app-activity.test.ts`:

```ts
it('runs every resource synchronizer before publishing React state', () => {
  const order: string[] = []
  applyAppActivity(
    true,
    [
      () => order.push('terminal'),
      () => order.push('clock')
    ],
    () => order.push('publish')
  )
  expect(order).toEqual(['terminal', 'clock', 'publish'])
})
```

In `TerminalPreview`, retain one poller across activity transitions:

```tsx
const active = useAppActivity()
const pollerRef = useRef<ActivityPoller | null>(null)

useEffect(() => {
  const poller = createActivityPoller(1500, () => setLines(previewText(id, 12)))
  pollerRef.current = poller
  poller.setActive(active)
  return () => {
    poller.dispose()
    if (pollerRef.current === poller) pollerRef.current = null
  }
}, [id])

useEffect(() => {
  pollerRef.current?.setActive(active)
}, [active])
```

In `TranscriptPane`, read `useAppActivity()` and add `pollerRef`. Keep `version`, `usingAgent`, the signature, and `tick` inside the effect keyed only by `[sessionId, agentSessionId]`, so they survive activity changes. Replace the immediate call, local `inFlight`, and raw interval with:

```tsx
const poller = createActivityPoller(500, tick)
pollerRef.current = poller
poller.setActive(active)
return () => {
  alive = false
  poller.dispose()
  if (pollerRef.current === poller) pollerRef.current = null
}
```

Add a separate `[active]` effect that calls `pollerRef.current?.setActive(active)`. Do not add `active` to the transcript-creation effect's dependency array. `ActivityPoller` retains its in-flight guard across background/foreground changes and queues exactly one immediate resume refresh if the previous IPC request is still pending.

Replace `Since` with:

```tsx
import { useNow } from '../now-clock'
import { formatSince } from '../state-meta'

export function Since({ from }: { from: number }): JSX.Element {
  return <span>{formatSince(from, useNow())}</span>
}
```

- [ ] **Step 7: Run focused validation**

Run: `npm test -- --run test/activity-poller.test.ts test/now-clock.test.ts test/renderer-app-activity.test.ts && npm run typecheck`

Expected: all selected tests PASS and both TypeScript projects report no errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/activity-poller.ts src/renderer/now-clock.ts src/renderer/app-activity.tsx src/renderer/components/TerminalPreview.tsx src/renderer/components/TranscriptPane.tsx src/renderer/components/Since.tsx test/activity-poller.test.ts test/now-clock.test.ts
git commit -m "perf: pause renderer polling in background"
```

---

### Task 4: Pause Decorative Motion and Verify the Performance Contract

**Files:**
- Modify: `src/renderer/styles.css`
- Create: `docs/performance/background-idle-measurement.md`
- Create: `test/background-idle-contract.test.ts`

**Interfaces:**
- Consumes: root class `crew-inactive` from Task 1.
- Verifies: the source-level contract that inactive renderers pause motion and that the signed-app measurement procedure checks every acceptance criterion.

- [ ] **Step 1: Write the failing contract test**

Create `test/background-idle-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
const measurement = readFileSync(
  new URL('../docs/performance/background-idle-measurement.md', import.meta.url),
  'utf8'
)

describe('background idle performance contract', () => {
  it('pauses decorative motion under the renderer inactive class', () => {
    expect(css).toContain('.crew-inactive *,')
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).toContain('transition: none !important')
  })

  it('documents every signed-app acceptance check', () => {
    expect(measurement).toContain('at least 80%')
    expect(measurement).toContain('30-second median below 5%')
    expect(measurement).toContain('Needs-you')
    expect(measurement).toContain('recent output')
    expect(measurement).toContain('signed')
    expect(measurement).toContain('Do not launch')
    expect(measurement).toContain('foreground.tsv')
    expect(measurement).toContain('background.tsv')
    expect(measurement).toContain('sample 5')
  })
})
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npm test -- --run test/background-idle-contract.test.ts`

Expected: FAIL because the measurement document and inactive CSS rule do not exist.

- [ ] **Step 3: Pause animations and transitions while inactive**

Append to `src/renderer/styles.css`:

```css
/* Main reports global inactivity. Preserve semantic state, but stop compositor
   and animation work until any Crew window regains focus. */
.crew-inactive *,
.crew-inactive *::before,
.crew-inactive *::after {
  animation-play-state: paused !important;
  transition: none !important;
}
```

- [ ] **Step 4: Document the signed-app measurement procedure**

Create `docs/performance/background-idle-measurement.md` with these exact sections and checks:

```markdown
# Background Idle Performance Measurement

Run this procedure only against an already-installed signed Crew app or a
Developer ID-signed candidate. Do not launch an unsigned Crew, Electron,
Playwright, or GUI E2E build on this machine.

## Preconditions

1. Record the absolute signed bundle path as `CREW_APP`, for example
   `/Applications/Crew.app`.
2. Confirm the bundle is signed:

   ```bash
   codesign --verify --deep --strict "$CREW_APP"
   ```

3. Open the same roster and number of Crew windows for baseline and candidate.
4. Select one session that is continuously producing terminal output.
5. Create a new empty evidence directory outside the repository:

   ```bash
   EVIDENCE_DIR="$HOME/Desktop/crew-background-perf-$(date +%Y%m%d-%H%M%S)"
   mkdir -p "$EVIDENCE_DIR"
   ```

## Process Inclusion Rule

Include every process whose executable command starts inside the exact signed
bundle: Crew main, every Crew Helper renderer, and Crew Helper GPU. Exclude
installers, shells, grep/awk, and processes from any other Crew bundle.

Resolve and freeze the candidate PID list before each sample run:

```bash
ps -axo pid=,command= |
  awk -v app="$CREW_APP/Contents/" 'index($0, app) { print $1 }' |
  sort -n > "$EVIDENCE_DIR/pids.txt"
cat "$EVIDENCE_DIR/pids.txt"
```

If the PID list changes during a run, discard that run and repeat it.

## Foreground Baseline

Keep a Crew window focused. Capture ten one-second combined-CPU samples:

```bash
: > "$EVIDENCE_DIR/foreground.tsv"
for second in $(seq 1 10); do
  pids=$(paste -sd, "$EVIDENCE_DIR/pids.txt")
  total=$(ps -o %cpu= -p "$pids" | awk '{ sum += $1 } END { printf "%.2f", sum }')
  printf "%s\t%s\n" "$second" "$total" | tee -a "$EVIDENCE_DIR/foreground.tsv"
  sleep 1
done
```

The foreground baseline is the median of these ten combined values.

## Background Samples

Focus a non-Crew app without hiding or quitting Crew and immediately run:

```bash
: > "$EVIDENCE_DIR/background.tsv"
for second in $(seq 1 30); do
  pids=$(paste -sd, "$EVIDENCE_DIR/pids.txt")
  total=$(ps -o %cpu= -p "$pids" | awk '{ sum += $1 } END { printf "%.2f", sum }')
  printf "%s\t%s\n" "$second" "$total" | tee -a "$EVIDENCE_DIR/background.tsv"
  sleep 1
done
```

Calculate the foreground median, background sample 5, the reduction at sample
5, and the 30-second background median:

```bash
python3 - "$EVIDENCE_DIR" <<'PY'
from pathlib import Path
from statistics import median
import sys

root = Path(sys.argv[1])
foreground = [float(line.split()[1]) for line in (root / "foreground.tsv").read_text().splitlines()]
background = [float(line.split()[1]) for line in (root / "background.tsv").read_text().splitlines()]
baseline = median(foreground)
at_five = background[4]
reduction = 100.0 if baseline == 0 and at_five == 0 else (baseline - at_five) / baseline * 100
result = (
    f"foreground_median={baseline:.2f}\n"
    f"background_sample_5={at_five:.2f}\n"
    f"reduction_at_5_seconds={reduction:.2f}%\n"
    f"background_30_second_median={median(background):.2f}\n"
)
(root / "summary.txt").write_text(result)
print(result, end="")
PY
```

## Correctness Checks

1. While Crew is backgrounded, drive one test session to the normal needs-you
   state. Confirm its roster/tray state changes and exactly one native
   notification arrives under the existing notification policy. Record pass or
   fail in `$EVIDENCE_DIR/correctness.txt`.
2. Keep another session producing distinct timestamped output while Crew is
   backgrounded.
3. Return focus to Crew, select that session, and confirm the selected terminal
   immediately shows recent output, accepts input, and is neither blank nor
   frozen. Record pass or fail in `$EVIDENCE_DIR/correctness.txt`.

## Acceptance

- `reduction_at_5_seconds` is at least 80%.
- `background_30_second_median` is below 5%.
- Needs-you detection and its single native notification work while backgrounded.
- Returning to Crew restores the selected terminal with recent output and no
  blank or frozen view.

Retain `pids.txt`, `foreground.tsv`, `background.tsv`, `summary.txt`, and
`correctness.txt` together. If any threshold or correctness check fails, retain
the evidence, identify the failed check, and do not describe the performance fix
as complete.
```

- [ ] **Step 5: Run complete non-GUI validation**

Run:

```bash
CREW_SKIP_BROWSER_TESTS=1 npm test
npm run typecheck
npm run build
git diff --check
```

Expected:
- All Vitest files pass.
- The Playwright renderer suite is reported skipped; no browser launches.
- `typecheck:node` and `typecheck:web` complete without errors.
- `electron-vite build` completes successfully.
- `git diff --check` prints no output.

Do not run `npm run test:e2e`, the Playwright suite without
`CREW_SKIP_BROWSER_TESTS=1`, `electron-vite dev`, `electron-vite preview`, or
any command that launches the unsigned app.

- [ ] **Step 6: Review the whole performance diff**

Inspect:

```bash
git diff --stat fbdfd8b
git diff fbdfd8b -- src/main src/preload src/shared src/renderer test docs/performance
```

Confirm:
- Main remains responsible for PTY and needs-you processing.
- Every activity subscription has cleanup.
- Inactive output cannot instantiate either terminal implementation.
- Resume creates only the visible terminal.
- No timer survives without active consumers.
- No version, publishing, updater, tracker, watcher, or webview behavior changed.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/styles.css docs/performance/background-idle-measurement.md test/background-idle-contract.test.ts
git commit -m "perf: pause background motion"
```

- [ ] **Step 8: Measure only when a signed candidate is available**

Follow `docs/performance/background-idle-measurement.md` against the signed candidate. If no signed candidate exists yet, record the measurement as blocked by the signed-app constraint; do not substitute an unsigned launch and do not claim the CPU thresholds are verified.
