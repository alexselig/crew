# Notification Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Crew notification stacks from repeatedly triggering macOS notification summarization while preserving useful needs-you alerts.

**Architecture:** Add a dependency-injected notification coordinator that batches newly waiting sessions, deduplicates each session until real user input, treats foreground-suppressed waits as already announced, and owns at most one active native notification. `CrewTray` adapts Electron notifications to the coordinator; the main IPC input boundary re-arms the matching session.

**Tech Stack:** TypeScript, Electron `Notification`, Vitest fake timers, existing `CrewTray` and main-process IPC.

## Global Constraints

- Do not change state detection, tray badges, tray menus, or renderer attention states.
- Batch eligible sessions for exactly 1,000 ms.
- Keep at most one Crew-owned native notification active.
- Re-arm a session only after actual user input.
- If any Crew `BrowserWindow` is focused, suppress the native alert entirely and
  still consume that session's current wait cycle.
- Existing delivered notifications may require manual clearing; never touch unrelated system notifications.
- Do not bump the application version or publish a release.

---

### Task 1: Build and test the notification coordinator

**Files:**
- Create: `src/main/notification-coordinator.ts`
- Create: `test/notification-coordinator.test.ts`

**Interfaces:**
- Consumes: `SessionInfo` snapshots from `src/shared/types.ts`.
- Produces: `NotificationCoordinator.queue()`, `suppress()`, `acknowledge()`, `reconcile()`, and `dispose()`.

- [ ] **Step 1: Write the failing coordinator tests**

Create `test/notification-coordinator.test.ts` with fake timers and a fake notice factory:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCoordinator, type NoticeRequest } from '../src/main/notification-coordinator'
import type { SessionInfo } from '../src/shared/types'

function session(id: string): SessionInfo {
  return {
    id,
    label: `Session ${id}`,
    characterId: 'fox',
    color: '#ff5a5a',
    presetId: 'copilot-cli',
    command: 'copilot',
    args: [],
    cwd: '/tmp',
    state: 'WAITING_INPUT',
    status: 'active',
    pid: 1,
    exitCode: null,
    costUsd: 0,
    creditsUsed: 0,
    autopilot: false,
    workspaceIds: [],
    createdAt: 1,
    stateChangedAt: 1
  }
}

describe('NotificationCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('batches fifty waiting sessions into one aggregate notification', () => {
    const shown: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    for (let i = 0; i < 50; i++) coordinator.queue(session(String(i)), false)
    vi.advanceTimersByTime(1000)

    expect(shown).toHaveLength(1)
    expect(shown[0]).toMatchObject({ title: 'Crew', body: '50 sessions need you' })
  })

  it('does not repeat a session until input acknowledges it', () => {
    const shown: NoticeRequest[] = []
    const coordinator = new NotificationCoordinator((request) => {
      shown.push(request)
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(1)

    coordinator.acknowledge('a')
    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    expect(shown).toHaveLength(2)
  })

  it('closes the prior notice before showing a later batch', () => {
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const coordinator = new NotificationCoordinator(() => {
      const close = vi.fn()
      closes.push(close)
      return { close }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    coordinator.queue(session('b'), false)
    vi.advanceTimersByTime(1000)

    expect(closes[0]).toHaveBeenCalledOnce()
  })

  it('single click jumps and aggregate click reveals Crew', () => {
    const requests: NoticeRequest[] = []
    const jump = vi.fn()
    const reveal = vi.fn()
    const coordinator = new NotificationCoordinator((request) => {
      requests.push(request)
      return { close: vi.fn() }
    }, jump, reveal)

    coordinator.queue(session('a'), false)
    vi.advanceTimersByTime(1000)
    requests[0].onClick()
    expect(jump).toHaveBeenCalledWith('a')

    coordinator.acknowledge('a')
    coordinator.queue(session('a'), false)
    coordinator.queue(session('b'), false)
    vi.advanceTimersByTime(1000)
    requests[1].onClick()
    expect(reveal).toHaveBeenCalledOnce()
  })

  it('reconcile and dispose cancel stale pending work', () => {
    const shown = vi.fn()
    const coordinator = new NotificationCoordinator(() => {
      shown()
      return { close: vi.fn() }
    }, vi.fn(), vi.fn())

    coordinator.queue(session('gone'), false)
    coordinator.reconcile(new Set())
    vi.advanceTimersByTime(1000)
    expect(shown).not.toHaveBeenCalled()

    coordinator.queue(session('alive'), false)
    coordinator.dispose()
    vi.advanceTimersByTime(1000)
    expect(shown).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npm test -- test/notification-coordinator.test.ts
```

Expected: FAIL because `src/main/notification-coordinator.ts` does not exist.

- [ ] **Step 3: Implement the coordinator**

Create `src/main/notification-coordinator.ts`:

```ts
import type { SessionInfo } from '../shared/types'

export interface NoticeRequest {
  title: string
  body: string
  silent: boolean
  onClick: () => void
}

export interface NoticeHandle {
  close: () => void
}

type NoticeFactory = (request: NoticeRequest) => NoticeHandle

interface PendingNotice {
  session: SessionInfo
  silent: boolean
}

export class NotificationCoordinator {
  private readonly announced = new Set<string>()
  private readonly pending = new Map<string, PendingNotice>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private active: NoticeHandle | null = null
  private destroyed = false

  constructor(
    private readonly showNotice: NoticeFactory,
    private readonly jumpTo: (id: string) => void,
    private readonly revealCrew: () => void
  ) {}

  queue(session: SessionInfo, silent: boolean): void {
    if (this.destroyed || this.announced.has(session.id)) return
    if (this.pending.has(session.id)) {
      this.pending.set(session.id, { session: { ...session }, silent })
      return
    }
    this.pending.set(session.id, { session: { ...session }, silent })
    this.timer ??= setTimeout(() => this.flush(), 1000)
  }

  acknowledge(id: string): void {
    this.announced.delete(id)
    this.pending.delete(id)
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  reconcile(activeIds: ReadonlySet<string>): void {
    for (const id of this.announced) if (!activeIds.has(id)) this.announced.delete(id)
    for (const id of this.pending.keys()) if (!activeIds.has(id)) this.pending.delete(id)
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.announced.clear()
    this.active?.close()
    this.active = null
  }

  private flush(): void {
    this.timer = null
    if (this.destroyed || this.pending.size === 0) return
    const batch = [...this.pending.values()]
    this.pending.clear()
    for (const { session } of batch) this.announced.add(session.id)
    this.active?.close()

    const single = batch.length === 1 ? batch[0] : null
    this.active = this.showNotice({
      title: single ? single.session.label : 'Crew',
      body: single
        ? single.session.state === 'WAITING_APPROVAL' ? 'needs your approval' : 'needs your input'
        : `${batch.length} sessions need you`,
      silent: batch.every((item) => item.silent),
      onClick: single ? () => this.jumpTo(single.session.id) : this.revealCrew
    })
  }
}
```

The tray integration in Task 2 adds the character glyph to the single-session
title by passing a copied `SessionInfo` whose display label is prefixed. Keep
Electron imports out of this file.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- test/notification-coordinator.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the isolated coordinator**

```bash
git add src/main/notification-coordinator.ts test/notification-coordinator.test.ts
git commit -m "fix: coalesce needs-you notifications"
```

### Task 2: Integrate the coordinator with Electron and user input

**Files:**
- Modify: `src/main/tray.ts:1-120`
- Modify: `src/main/index.ts:605-613,900-906`
- Test: `test/notification-coordinator.test.ts`

**Interfaces:**
- Consumes: `NotificationCoordinator` from Task 1.
- Produces: `CrewTray.notify()`, `CrewTray.suppress()`, `CrewTray.acknowledge()`, roster reconciliation, and clean teardown.

- [ ] **Step 1: Add failing integration assertions**

Extend the tests to assert:

```ts
it('uses the latest session snapshot in a pending batch', () => {
  const requests: NoticeRequest[] = []
  const coordinator = new NotificationCoordinator((request) => {
    requests.push(request)
    return { close: vi.fn() }
  }, vi.fn(), vi.fn())
  const first = session('a')
  coordinator.queue(first, true)
  coordinator.queue({ ...first, label: 'Updated' }, false)
  vi.advanceTimersByTime(1000)
  expect(requests[0].title).toBe('Updated')
  expect(requests[0].silent).toBe(false)
})
```

Update `queue()` so a pending session refreshes its snapshot without creating a
second entry.

Add focused main-process coverage proving:

- a focused Crew window calls `tray.suppress(session.id)` and does not call
  `tray.notify(...)`, even when `notifyOnlyWhenUnfocused` is false;
- an unfocused Crew window still calls `tray.notify(...)`;
- the tray exposes `suppress(id)` and the transition handler uses it.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- test/notification-coordinator.test.ts
```

Expected: FAIL until pending snapshots are updated deterministically.

- [ ] **Step 3: Wire `CrewTray`**

In `src/main/tray.ts`:

```ts
import { NotificationCoordinator, type NoticeRequest } from './notification-coordinator'

private readonly notifications: NotificationCoordinator

constructor(private readonly cb: TrayCallbacks) {
  this.tray = new Tray(buildTrayIcon())
  this.notifications = new NotificationCoordinator(
    (request) => this.showNativeNotification(request),
    cb.onJump,
    cb.onShow
  )
  // existing tray setup
}

notify(session: SessionInfo, silent = false): void {
  if (this.destroyed || !Notification.isSupported()) return
  const character = getCharacter(session.characterId)
  this.notifications.queue(
    { ...session, label: `${character?.glyph ?? '●'}  ${session.label}` },
    silent
  )
}

acknowledge(id: string): void {
  this.notifications.acknowledge(id)
}

suppress(id: string): void {
  this.notifications.suppress(id)
}

private showNativeNotification(request: NoticeRequest): { close: () => void } {
  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: request.silent
  })
  notification.on('click', request.onClick)
  notification.show()
  return { close: () => notification.close() }
}
```

At the end of `update(roster)`, reconcile active session IDs:

```ts
this.notifications.reconcile(new Set(active.map((session) => session.id)))
```

In `destroy()` call `this.notifications.dispose()` before destroying the native
tray.

In `src/main/index.ts`, acknowledge actual user interaction at the IPC boundary:

```ts
ipcMain.on(IPC.SESSION_INPUT, (_e, p: { id: string; data: string }) => {
  tray?.acknowledge(p.id)
  manager.input(p.id, p.data)
})
```

Also, in the transition handler, suppress foreground delivery without queueing
or deferring it:

```ts
if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) {
  tray?.suppress(session.id)
  return
}
```

- [ ] **Step 4: Run notification and main reliability tests**

Run:

```bash
npm test -- test/notification-coordinator.test.ts test/main-reliability.test.ts
npm run typecheck:node
```

Expected: PASS with no new TypeScript errors.

- [ ] **Step 5: Commit integration**

```bash
git add src/main/tray.ts src/main/index.ts test/notification-coordinator.test.ts
git commit -m "fix: deduplicate Crew notification waves"
```

### Task 3: Verify notification behavior and document the operational limit

**Files:**
- Modify: `CHANGELOG.md`
- Test: all existing suites

**Interfaces:**
- Consumes: completed notification coordinator.
- Produces: verified fix with documented behavior.

- [ ] **Step 1: Add an Unreleased changelog entry**

Add:

```md
## Unreleased

### Fixed
- **Needs-you alerts no longer build unbounded notification stacks.** Crew batches
  sessions that finish together, announces each session once until you interact
  with it, and replaces its previous native notification. This prevents repeated
  macOS notification summarization from pinning `suggestd`.
```

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all tests pass, both typechecks pass, production build succeeds, and
`git diff --check` prints nothing.

- [ ] **Step 3: Run the bounded stress harness**

Use the coordinator test with fifty synthetic sessions as the non-invasive stress
test. Do not send fifty real system notifications and do not clear unrelated
Notification Center entries.

Run:

```bash
npm test -- test/notification-coordinator.test.ts -t "batches fifty"
```

Expected: one notice-factory call.

- [ ] **Step 4: Commit documentation**

```bash
git add CHANGELOG.md
git commit -m "docs: note notification stack protection"
```
