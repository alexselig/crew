# Custom Session Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named custom roster views where sessions can be searched, dragged into an independent ranked order, and displayed either alone or ahead of all remaining sessions.

**Architecture:** Store validated `CustomView` records in Crew's existing durable JSON Store. Use pure shared helpers for validation, draft movement, search, and roster composition; expose typed IPC; keep per-window presentation selection in existing view preferences; render editing through a two-column organizer.

**Tech Stack:** TypeScript, React, Electron IPC/contextBridge, existing Store atomic persistence, HTML drag-and-drop, Vitest, Playwright Electron E2E.

## Global Constraints

- Custom views never change session lifecycle, workspace membership, or global roster order.
- A session may be ranked independently in multiple views.
- View modes are exactly `curated-only` and `ranked-plus-all`.
- Array order is rank; no independent numeric rank is persisted.
- Search covers label, cwd, tag, workspace name, and preset name.
- Pointer and keyboard users must be able to add, remove, and reorder sessions.
- Deleting a view never deletes or mutates sessions.
- Do not bump the application version or publish a release.

---

### Task 1: Define and test the custom-view domain

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/custom-views.ts`
- Create: `test/custom-views.test.ts`

**Interfaces:**
- Consumes: `SessionInfo`, `Workspace`, and preset display names.
- Produces: `CustomView`, `CustomViewItem`, `CustomViewMode`, `SessionPresentation`, `composeCustomView()`, `searchCustomViewSessions()`, and draft movement helpers.

- [ ] **Step 1: Write failing domain tests**

Create tests for exact behavior:

```ts
import { describe, expect, it } from 'vitest'
import {
  composeCustomView,
  moveIntoView,
  moveWithinView,
  removeFromView,
  searchCustomViewSessions
} from '../src/shared/custom-views'
import type { CustomView, SessionInfo } from '../src/shared/types'

const view = (mode: CustomView['mode'], ids: string[]): CustomView => ({
  id: 'view-1',
  name: 'Today',
  mode,
  items: ids.map((sessionId) => ({ sessionId, labelSnapshot: sessionId })),
  createdAt: 1,
  updatedAt: 1
})

it('composes curated-only in item order and reports missing entries', () => {
  const result = composeCustomView([session('b'), session('a')], view('curated-only', ['a', 'missing', 'b']))
  expect(result.sessions.map((s) => s.id)).toEqual(['a', 'b'])
  expect(result.missing.map((item) => item.sessionId)).toEqual(['missing'])
})

it('appends unranked sessions by recent activity', () => {
  const result = composeCustomView(
    [session('old', 10), session('ranked', 1), session('new', 20)],
    view('ranked-plus-all', ['ranked'])
  )
  expect(result.sessions.map((s) => s.id)).toEqual(['ranked', 'new', 'old'])
})

it('inserts, reorders, and removes without duplicates', () => {
  expect(moveIntoView(['a', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
  expect(moveIntoView(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
  expect(moveWithinView(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  expect(removeFromView(['a', 'b'], 'a')).toEqual(['b'])
})

it('searches all approved session fields', () => {
  const matches = searchCustomViewSessions({
    sessions: [session('a')],
    query: 'release',
    workspaces: [{ id: 'ws', name: 'Release', order: 0, createdAt: 1 }],
    presetNames: new Map([['copilot-cli', 'Copilot CLI']])
  })
  expect(matches.map((s) => s.id)).toEqual(['a'])
})
```

Use a local `session(id, lastPromptAt)` fixture containing tag, cwd,
workspaceIds, and presetId so each searchable field gets an explicit assertion.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- test/custom-views.test.ts
```

Expected: FAIL because the types and helper module do not exist.

- [ ] **Step 3: Add exact shared types**

Add to `src/shared/types.ts`:

```ts
export type CustomViewMode = 'curated-only' | 'ranked-plus-all'

export interface CustomViewItem {
  sessionId: string
  labelSnapshot: string
}

export interface CustomView {
  id: string
  name: string
  mode: CustomViewMode
  items: CustomViewItem[]
  createdAt: number
  updatedAt: number
}

export type SessionPresentation =
  | { kind: 'builtin'; mode: 'none' | 'needs' | 'tag' | 'recent' }
  | { kind: 'custom'; viewId: string }
```

- [ ] **Step 4: Implement pure helpers**

Create `src/shared/custom-views.ts`. Implement:

```ts
export function composeCustomView(
  roster: SessionInfo[],
  view: CustomView
): { sessions: SessionInfo[]; missing: CustomViewItem[] }

export function moveIntoView(ids: string[], sessionId: string, index: number): string[]
export function moveWithinView(ids: string[], sessionId: string, index: number): string[]
export function removeFromView(ids: string[], sessionId: string): string[]

export function searchCustomViewSessions(input: {
  sessions: SessionInfo[]
  query: string
  workspaces: Workspace[]
  presetNames: ReadonlyMap<string | null, string>
  workspaceId?: string
  status?: SessionInfo['status'] | 'all'
  presetId?: string | null | 'all'
}): SessionInfo[]
```

Normalize search with `trim().toLocaleLowerCase()`. Build each session haystack
from label, cwd, tag, matching workspace names, and preset display name. Preserve
roster order after filtering.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
npm test -- test/custom-views.test.ts
npm run typecheck:node
```

Expected: all custom-view tests pass.

- [ ] **Step 6: Commit the domain**

```bash
git add src/shared/types.ts src/shared/custom-views.ts test/custom-views.test.ts
git commit -m "feat: add custom session view model"
```

### Task 2: Persist validated custom views

**Files:**
- Modify: `src/main/store.ts`
- Modify: `test/store-migrations.test.ts`
- Create: `test/custom-view-store.test.ts`

**Interfaces:**
- Consumes: `CustomView` shared types.
- Produces: `Store.getCustomViews()`, `createCustomView()`, `updateCustomView()`, and `deleteCustomView()`.

- [ ] **Step 1: Write failing Store tests**

Cover:

```ts
expect(new Store(path).getCustomViews()).toEqual([])
expect(store.createCustomView({ name: 'Today', mode: 'curated-only', items: [] }).name).toBe('Today')
expect(() => store.createCustomView({ name: ' today ', mode: 'curated-only', items: [] })).toThrow(/already exists/i)
expect(store.updateCustomView(id, { name: 'Release', mode: 'ranked-plus-all', items })).toMatchObject({ name: 'Release' })
expect(store.deleteCustomView(id)).toEqual([])
```

Read the persisted JSON after every mutation and assert unrelated sessions,
workspaces, agents, and settings remain unchanged.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- test/custom-view-store.test.ts test/store-migrations.test.ts
```

Expected: FAIL because Store has no custom-view field or methods.

- [ ] **Step 3: Add Store data and validation**

Add `customViews: CustomView[]` to `StoreData`, `EMPTY`, `parseStore()`, and the
loaded-data merge. Existing files with no field load as `[]`; do not add a
one-time migration because the defaulted schema addition is idempotent.

Implement:

```ts
getCustomViews(): CustomView[] {
  return structuredClone(this.data.customViews)
}

createCustomView(input: Pick<CustomView, 'name' | 'mode' | 'items'>): CustomView
updateCustomView(id: string, input: Pick<CustomView, 'name' | 'mode' | 'items'>): CustomView
deleteCustomView(id: string): CustomView[]
```

Use `randomUUID()` for new IDs and `Date.now()` for timestamps. Validate trimmed
case-insensitive name uniqueness, known mode, finite timestamps, non-empty
session IDs, and deduplicated items. Clone return values so renderer callers
cannot mutate Store state.

- [ ] **Step 4: Run Store tests and verify GREEN**

```bash
npm test -- test/custom-view-store.test.ts test/store-migrations.test.ts test/store-durability.test.ts
```

Expected: PASS with durability tests unchanged.

- [ ] **Step 5: Commit persistence**

```bash
git add src/main/store.ts test/custom-view-store.test.ts test/store-migrations.test.ts
git commit -m "feat: persist custom session views"
```

### Task 3: Add typed IPC and renderer state

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/hooks.ts`
- Test: `test/main-reliability.test.ts`

**Interfaces:**
- Consumes: Store custom-view methods.
- Produces: renderer API and `CrewState.customViews`, `presentation`, and `showCustomViewEditor`.

- [ ] **Step 1: Add failing IPC contract assertions**

Extend `test/main-reliability.test.ts`:

```ts
expect(source).toContain('IPC.CUSTOM_VIEWS_GET')
expect(source).toContain('store.createCustomView')
expect(source).toContain('store.updateCustomView')
expect(source).toContain('store.deleteCustomView')
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npm test -- test/main-reliability.test.ts
```

Expected: FAIL on missing custom-view IPC wiring.

- [ ] **Step 3: Add IPC constants and API**

Add:

```ts
CUSTOM_VIEWS_GET: 'customViews:get',
CUSTOM_VIEW_CREATE: 'customViews:create',
CUSTOM_VIEW_UPDATE: 'customViews:update',
CUSTOM_VIEW_DELETE: 'customViews:delete',
EVT_CUSTOM_VIEWS: 'evt:customViews',
```

Add `CrewAPI` methods:

```ts
getCustomViews(): Promise<CustomView[]>
createCustomView(input: CustomViewInput): Promise<CustomView[]>
updateCustomView(id: string, input: CustomViewInput): Promise<CustomView[]>
deleteCustomView(id: string): Promise<CustomView[]>
onCustomViews(cb: (views: CustomView[]) => void): Unsubscribe
```

Define `CustomViewInput = Pick<CustomView, 'name' | 'mode' | 'items'>`.

- [ ] **Step 4: Wire main and preload**

Each mutation handler calls Store, broadcasts `EVT_CUSTOM_VIEWS`, and returns the
complete list. Do not mutate sessions.

- [ ] **Step 5: Add renderer state**

In `useCrew()`:

- Load custom views during mount.
- Subscribe to `onCustomViews`.
- Parse `readViewPref('sessionPresentation')`.
- Fall back to `{ kind: 'builtin', mode: 'recent' }` if a selected custom ID is
  missing.
- Persist selection with `writeViewPref`.
- Add `showCustomViewEditor: string | 'new' | null`.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- test/main-reliability.test.ts test/custom-view-store.test.ts
npm run typecheck
git add src/shared/types.ts src/shared/api.ts src/main/index.ts src/preload/index.ts src/renderer/hooks.ts test/main-reliability.test.ts
git commit -m "feat: expose custom views to the renderer"
```

### Task 4: Extend the view picker and compose the visible roster

**Files:**
- Modify: `src/renderer/components/GroupPicker.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Roster.tsx`
- Modify: `src/renderer/components/GridView.tsx`
- Modify: `src/renderer/grouping.ts`
- Test: `test/grouping.test.ts`
- Test: `src/renderer/__tests__/renderer-regressions.tsx`

**Interfaces:**
- Consumes: `SessionPresentation`, `CustomView[]`, and `composeCustomView()`.
- Produces: custom-view selection in both roster and grid.

- [ ] **Step 1: Add failing composition and fallback tests**

Test that:

- Workspace filtering happens before custom-view composition.
- Ranked order appears identically in roster and grid.
- `ranked-plus-all` appends Recent order.
- Missing selected views fall back to built-in Recent.
- Selecting a custom view does not invoke `window.crew.reorder`.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- test/grouping.test.ts src/renderer/__tests__/renderer-regressions.tsx
```

- [ ] **Step 3: Replace picker props**

Change `GroupPicker` to:

```ts
interface Props {
  presentation: SessionPresentation
  customViews: CustomView[]
  onChoose: (presentation: SessionPresentation) => void
  onCreateCustomView: () => void
  onEditCustomView: (id: string) => void
}
```

Render built-ins first, then a **Custom views** label, saved views, and
**New custom view**. Show an edit affordance only for the active custom view.

- [ ] **Step 4: Compose once in App**

After workspace filtering, compute:

```ts
const presentedRoster = useMemo(() => {
  if (c.presentation.kind === 'builtin') return visibleRoster
  const view = c.customViews.find((item) => item.id === c.presentation.viewId)
  return view ? composeCustomView(visibleRoster, view).sessions : [...visibleRoster].sort(byRecent)
}, [visibleRoster, c.presentation, c.customViews])
```

Pass `presentedRoster` to both `Roster` and `GridView`. Pass the builtin mode
separately when `presentation.kind === 'builtin'`; custom presentation renders
as ungrouped and disables ordinary roster/grid reorder DnD.

- [ ] **Step 5: Run tests and commit**

```bash
npm test -- test/grouping.test.ts src/renderer/__tests__/renderer-regressions.tsx
npm run typecheck:web
git add src/renderer/components/GroupPicker.tsx src/renderer/App.tsx src/renderer/components/Roster.tsx src/renderer/components/GridView.tsx src/renderer/grouping.ts test/grouping.test.ts src/renderer/__tests__/renderer-regressions.tsx
git commit -m "feat: select and render custom session views"
```

### Task 5: Build the two-column organizer

**Files:**
- Create: `src/renderer/components/CustomViewOrganizer.tsx`
- Create: `src/renderer/custom-view-dnd.ts`
- Create: `test/custom-view-dnd.test.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Test: `src/renderer/__tests__/renderer-regressions.tsx`

**Interfaces:**
- Consumes: roster, workspaces, presets, existing custom view, and typed Crew API.
- Produces: create/edit/delete UI with search, filters, pointer DnD, and keyboard ordering.

- [ ] **Step 1: Write failing DnD reducer tests**

Create pure reducer tests for:

```ts
reduceOrganizer(draft, { type: 'insert', session, index })
reduceOrganizer(draft, { type: 'move', sessionId, index })
reduceOrganizer(draft, { type: 'remove', sessionId })
reduceOrganizer(draft, { type: 'move-up', sessionId })
reduceOrganizer(draft, { type: 'move-down', sessionId })
reduceOrganizer(draft, { type: 'move-first', sessionId })
reduceOrganizer(draft, { type: 'move-last', sessionId })
```

Assert contiguous ordering and no duplicates after every action.

- [ ] **Step 2: Run tests and verify RED**

```bash
npm test -- test/custom-view-dnd.test.ts
```

- [ ] **Step 3: Implement the pure organizer reducer**

Keep DOM drag events out of the reducer. The reducer accepts full session
snapshots only when inserting so it can store `labelSnapshot`.

- [ ] **Step 4: Implement `CustomViewOrganizer`**

Required props:

```ts
interface Props {
  view: CustomView | null
  roster: SessionInfo[]
  workspaces: Workspace[]
  presets: Preset[]
  onSaved: (views: CustomView[]) => void
  onDeleted: (views: CustomView[]) => void
  onClose: () => void
}
```

Required UI:

- Name input and mode selector.
- Left search field with workspace, status, and preset filters.
- Left available-session cards with draggable handles.
- Right numbered ranked cards and insertion drop lines.
- Right-to-right reorder and right-to-left removal.
- Keyboard Add/Remove/First/Up/Down/Last buttons with accessible names.
- Missing items rendered as Unavailable using `labelSnapshot`.
- Save, Cancel, and confirmed Delete.
- Inline error region with `role="alert"`.

Save calls create or update once. Cancel performs no API call. Delete calls
`deleteCustomView()` only after confirmation.

- [ ] **Step 5: Add Obsidian CSS**

Use Crew's existing tokens: `--bg`, `--bg-elev`, `--border`, `--text`,
`--text-dim`, `--accent`, radius 4px, no new accent colors, and the existing
floating shadow only for the dragged card.

- [ ] **Step 6: Verify renderer behavior and commit**

```bash
npm test -- test/custom-view-dnd.test.ts src/renderer/__tests__/renderer-regressions.tsx
npm run typecheck:web
git add src/renderer/components/CustomViewOrganizer.tsx src/renderer/custom-view-dnd.ts src/renderer/App.tsx src/renderer/styles.css test/custom-view-dnd.test.ts src/renderer/__tests__/renderer-regressions.tsx
git commit -m "feat: organize ranked sessions in custom views"
```

### Task 6: Add E2E coverage and user documentation

**Files:**
- Modify: `test/e2e/crew.e2e.mjs`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: complete custom-view feature.
- Produces: persisted relaunch coverage and user-facing documentation.

- [ ] **Step 1: Add the failing E2E scenario**

In the existing app run:

1. Create three sessions.
2. Open **New custom view**.
3. Name it `Release queue`.
4. Search for one session and drag it to rank 1.
5. Drag a second session directly to rank 1 and assert the first becomes rank 2.
6. Save and select the view.
7. Assert roster and grid order match.
8. Restart Crew and assert selection and order persist.
9. Edit the view, drag one session back left, save, and assert removal.
10. Delete the active view and assert fallback to Recent.
11. Assert zero renderer and main-process errors.

- [ ] **Step 2: Run E2E and verify RED**

```bash
npm run test:e2e
```

Expected: FAIL until selectors and persistence behavior are complete.

- [ ] **Step 3: Complete missing behavior exposed by E2E**

Fix only custom-view defects found by the scenario. Do not refactor unrelated
workspace or terminal behavior.

- [ ] **Step 4: Update README and changelog**

Add a Custom Views feature description and an Unreleased changelog entry:

```md
### Added
- **Named Custom Views organize sessions into a personal ranked queue.** Search
  the full roster in a two-column organizer, drag sessions directly into rank,
  and choose whether a view shows only ranked work or ranked work followed by
  every remaining session.
```

- [ ] **Step 5: Run final verification**

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
git diff --check
```

Expected: all unit tests pass, both typechecks pass, production build succeeds,
E2E passes with zero renderer/main errors, and diff check is clean.

- [ ] **Step 6: Commit E2E and docs**

```bash
git add test/e2e/crew.e2e.mjs README.md CHANGELOG.md
git commit -m "test: verify custom views across relaunch"
```
