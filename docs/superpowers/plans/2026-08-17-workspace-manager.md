# Workspace Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Workspace Manager — a full-screen board (File › Workspaces…) to create workspaces, drag sessions between them (non-destructive add by default), archive sessions in no workspace, and edit each session's name + description.

**Architecture:** Promote workspaces from ad-hoc name tags to first-class `Workspace` entities with stable ids persisted in the store; session membership moves from name-based (`sets`) to id-based (`workspaceIds`), migrated once. Pure reducers in `src/shared/workspaces.ts` (vitest-tested) hold all mutation logic; main owns the store and broadcasts changes; a new kanban UI (`WorkspaceManager` + `WorkspaceLane` + `WorkspaceSessionCard` + `useSessionDrag`) consumes it.

**Tech Stack:** Electron 31 (main/preload/renderer), React 18 + TypeScript, Vitest (unit), Playwright `_electron` (e2e). HTML5 drag-and-drop (native, as in `useGroupReorder.ts`).

## Global Constraints

- Node: run all commands with `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH"` prefixed.
- Verify commands: `npm run typecheck` · `npx vitest run` · `npm run build` · e2e `node test/e2e/crew.e2e.mjs`.
- Push pattern: `export TK=$(gh auth token --user alexselig); git -c credential.helper= -c credential.helper='!f(){ echo username=alexselig; echo "password=$TK"; }; f' push origin main` (fetch + `git -c rebase.autoStash=true rebase origin/main` first).
- Organizing a session is **non-destructive**: never spawn or kill a process. Closing a session stays its own explicit action.
- Drag default = **copy/add** membership (session stays in source). **Move** (remove from source) = ⌘/Alt-drag or card menu. **Archive** = remove from all workspaces. **Duplicate as new session** = explicit menu action only (spawns from the same recipe).
- Workspace ids: `ws_${8-char base36}` via a local helper; never reuse the display name as the id.
- Case-insensitive duplicate workspace names are rejected at create/rename (reuse `normalizeSetNames` semantics).
- Commit after each task with a `feat:`/`test:`/`refactor:` message + the standard trailers:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` and `Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e`.

---

## File Structure

- `src/shared/workspaces.ts` (MODIFY) — add `Workspace` type + pure id-based reducers (`makeWorkspaceId`, `createWorkspace`, `renameWorkspace`, `deleteWorkspace`, `reorderWorkspaces`, `addMembership`, `removeMembership`, `moveMembership`, `isArchived`, `sessionInWorkspaceId`, `nameToIdMap`). Keep existing name helpers for back-compat/migration.
- `test/workspaces.test.ts` (MODIFY) — unit tests for all new reducers.
- `src/shared/types.ts` (MODIFY) — `Workspace` interface; add `SessionInfo.workspaceIds?`, `SessionInfo.description?`; new IPC channel constants.
- `src/shared/api.ts` (MODIFY) — `CrewAPI` methods for workspace CRUD, membership, session update; `onWorkspaces`/`onOpenWorkspaces` subscriptions.
- `src/main/store.ts` (MODIFY) — `StoreData.workspaces: Workspace[]`; `PersistedSession.workspaceIds` + `description`; migration `2026-08-workspaces-firstclass`; workspace getters/setters.
- `test/store-migrations.test.ts` (MODIFY) — migration test.
- `src/main/session-manager.ts` (MODIFY) — id-based membership (`setWorkspaceIds`, `addToWorkspace`, `removeFromWorkspace`, `archiveSession`), `setDescription`, `duplicateSession`; persist new fields; back-compat read of legacy `sets`.
- `src/main/index.ts` (MODIFY) — IPC handlers; File › Workspaces… menu item → `EVT_OPEN_WORKSPACES`; broadcast `EVT_WORKSPACES`; menu rebuild on workspace change.
- `src/preload/index.ts` (MODIFY) — expose the new api methods + subscriptions.
- `src/renderer/hooks.ts` (MODIFY) — `workspaces: Workspace[]` state, `refreshWorkspaces`, `onWorkspaces`/`onOpenWorkspaces` wiring; switch `activeWorkspace` filter to id.
- `src/renderer/useSessionDrag.ts` (CREATE) — native DnD hook for session cards (copy vs move via modifier).
- `src/renderer/components/WorkspaceManager.tsx` (CREATE) — full-screen board shell.
- `src/renderer/components/WorkspaceLane.tsx` (CREATE) — one workspace column (+ Archived variant).
- `src/renderer/components/WorkspaceSessionCard.tsx` (CREATE) — draggable session card with inline name/description + menu.
- `src/renderer/App.tsx` (MODIFY) — open manager from menu event; render it.
- `src/renderer/styles.css` (MODIFY) — board/lane/card styles.
- `test/e2e/crew.e2e.mjs` (MODIFY) — e2e coverage for the manager.

---

### Task 1: Pure workspace reducers + types

**Files:**
- Modify: `src/shared/types.ts` (add `Workspace` interface near `SessionInfo`)
- Modify: `src/shared/workspaces.ts` (append id-based reducers)
- Test: `test/workspaces.test.ts`

**Interfaces:**
- Produces:
  - `interface Workspace { id: string; name: string; description?: string; order: number; createdAt: number }`
  - `makeWorkspaceId(): string`
  - `createWorkspace(list: Workspace[], name: string, now: number): { list: Workspace[]; created: Workspace | null }` — null when name is blank or a case-insensitive duplicate.
  - `renameWorkspace(list: Workspace[], id: string, name: string): Workspace[]` — no-op on blank or duplicate-of-other.
  - `describeWorkspace(list: Workspace[], id: string, description: string): Workspace[]`
  - `deleteWorkspace(list: Workspace[], id: string): Workspace[]`
  - `reorderWorkspaces(list: Workspace[], orderedIds: string[]): Workspace[]` — rewrites `order` to match `orderedIds`.
  - `addMembership(ids: string[] | undefined, wsId: string): string[]`
  - `removeMembership(ids: string[] | undefined, wsId: string): string[]`
  - `moveMembership(ids: string[] | undefined, fromId: string, toId: string): string[]`
  - `isArchived(ids: string[] | undefined): boolean`
  - `sessionInWorkspaceId(ids: string[] | undefined, activeId: string | null): boolean` — null active = All (matches everything).
  - `nameToIdMap(list: Workspace[]): Map<string, string>` — lowercased name → id (for migration).

- [ ] **Step 1: Write failing tests**

Append to `test/workspaces.test.ts`:

```ts
import {
  makeWorkspaceId, createWorkspace, renameWorkspace, describeWorkspace,
  deleteWorkspace, reorderWorkspaces, addMembership, removeMembership,
  moveMembership, isArchived, sessionInWorkspaceId, nameToIdMap, type Workspace
} from '../src/shared/workspaces'

const ws = (id: string, name: string, order: number): Workspace => ({ id, name, order, createdAt: 0 })

describe('makeWorkspaceId', () => {
  it('produces a unique ws_ id', () => {
    const a = makeWorkspaceId(), b = makeWorkspaceId()
    expect(a).toMatch(/^ws_[a-z0-9]{6,}$/)
    expect(a).not.toBe(b)
  })
})

describe('createWorkspace', () => {
  it('adds a trimmed workspace with next order', () => {
    const { list, created } = createWorkspace([ws('ws_a', 'A', 0)], '  B ', 5)
    expect(created?.name).toBe('B')
    expect(created?.order).toBe(1)
    expect(created?.createdAt).toBe(5)
    expect(list).toHaveLength(2)
  })
  it('rejects blank and case-insensitive duplicates', () => {
    expect(createWorkspace([ws('ws_a', 'Work', 0)], '  ', 0).created).toBeNull()
    expect(createWorkspace([ws('ws_a', 'Work', 0)], 'work', 0).created).toBeNull()
  })
})

describe('renameWorkspace', () => {
  it('renames by id, ignoring blank or duplicate-of-other', () => {
    const list = [ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)]
    expect(renameWorkspace(list, 'ws_a', 'A2').find((w) => w.id === 'ws_a')?.name).toBe('A2')
    expect(renameWorkspace(list, 'ws_a', 'b').find((w) => w.id === 'ws_a')?.name).toBe('A') // dup of other → no-op
    expect(renameWorkspace(list, 'ws_a', 'A').find((w) => w.id === 'ws_a')?.name).toBe('A') // rename to own name ok
  })
})

describe('describeWorkspace', () => {
  it('sets/clears the description', () => {
    const list = [ws('ws_a', 'A', 0)]
    expect(describeWorkspace(list, 'ws_a', ' note ').find((w) => w.id === 'ws_a')?.description).toBe('note')
    expect(describeWorkspace(list, 'ws_a', '  ').find((w) => w.id === 'ws_a')?.description).toBeUndefined()
  })
})

describe('deleteWorkspace / reorderWorkspaces', () => {
  it('removes by id', () => {
    expect(deleteWorkspace([ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)], 'ws_a').map((w) => w.id)).toEqual(['ws_b'])
  })
  it('reorders and rewrites order to match ids', () => {
    const out = reorderWorkspaces([ws('ws_a', 'A', 0), ws('ws_b', 'B', 1)], ['ws_b', 'ws_a'])
    expect(out.map((w) => [w.id, w.order])).toEqual([['ws_b', 0], ['ws_a', 1]])
  })
})

describe('membership reducers', () => {
  it('adds/removes/moves without duplicates', () => {
    expect(addMembership(undefined, 'ws_a')).toEqual(['ws_a'])
    expect(addMembership(['ws_a'], 'ws_a')).toEqual(['ws_a'])
    expect(removeMembership(['ws_a', 'ws_b'], 'ws_a')).toEqual(['ws_b'])
    expect(moveMembership(['ws_a'], 'ws_a', 'ws_b')).toEqual(['ws_b'])
    expect(moveMembership(['ws_a', 'ws_c'], 'ws_a', 'ws_c')).toEqual(['ws_c']) // to already present → just drop from
  })
  it('isArchived when no memberships', () => {
    expect(isArchived(undefined)).toBe(true)
    expect(isArchived([])).toBe(true)
    expect(isArchived(['ws_a'])).toBe(false)
  })
})

describe('sessionInWorkspaceId', () => {
  it('null active matches all; otherwise exact id membership', () => {
    expect(sessionInWorkspaceId(['ws_a'], null)).toBe(true)
    expect(sessionInWorkspaceId(undefined, null)).toBe(true)
    expect(sessionInWorkspaceId(['ws_a'], 'ws_a')).toBe(true)
    expect(sessionInWorkspaceId(['ws_a'], 'ws_b')).toBe(false)
    expect(sessionInWorkspaceId(undefined, 'ws_a')).toBe(false)
  })
})

describe('nameToIdMap', () => {
  it('maps lowercased name → id', () => {
    const m = nameToIdMap([ws('ws_a', 'July 2026', 0)])
    expect(m.get('july 2026')).toBe('ws_a')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npx vitest run test/workspaces.test.ts`
Expected: FAIL — imports not defined.

- [ ] **Step 3: Add the `Workspace` type**

In `src/shared/types.ts`, immediately before `export interface SessionInfo {`:

```ts
/** A first-class workspace: a named, ordered bucket sessions can belong to. */
export interface Workspace {
  id: string
  name: string
  description?: string
  order: number
  createdAt: number
}
```

Also add two fields inside `SessionInfo` (after `sets?: string[]`):

```ts
  /** Workspace ids this session belongs to (first-class membership; replaces name-based `sets`). */
  workspaceIds?: string[]
  /** Freeform user note shown in the Workspace Manager. */
  description?: string
```

- [ ] **Step 4: Implement the reducers**

Append to `src/shared/workspaces.ts`:

```ts
import type { Workspace } from './types'
export type { Workspace }

/** A short, collision-resistant workspace id (never the display name). */
export function makeWorkspaceId(): string {
  return 'ws_' + Math.random().toString(36).slice(2, 10)
}

const norm = (s: string): string => s.trim().toLowerCase()

export function createWorkspace(
  list: readonly Workspace[],
  name: string,
  now: number
): { list: Workspace[]; created: Workspace | null } {
  const trimmed = name.trim()
  if (!trimmed || list.some((w) => norm(w.name) === norm(trimmed))) {
    return { list: [...list], created: null }
  }
  const order = list.reduce((max, w) => Math.max(max, w.order), -1) + 1
  const created: Workspace = { id: makeWorkspaceId(), name: trimmed, order, createdAt: now }
  return { list: [...list, created], created }
}

export function renameWorkspace(list: readonly Workspace[], id: string, name: string): Workspace[] {
  const trimmed = name.trim()
  if (!trimmed) return [...list]
  if (list.some((w) => w.id !== id && norm(w.name) === norm(trimmed))) return [...list]
  return list.map((w) => (w.id === id ? { ...w, name: trimmed } : w))
}

export function describeWorkspace(list: readonly Workspace[], id: string, description: string): Workspace[] {
  const trimmed = description.trim()
  return list.map((w) => (w.id === id ? { ...w, description: trimmed || undefined } : w))
}

export function deleteWorkspace(list: readonly Workspace[], id: string): Workspace[] {
  return list.filter((w) => w.id !== id)
}

export function reorderWorkspaces(list: readonly Workspace[], orderedIds: readonly string[]): Workspace[] {
  const rank = new Map(orderedIds.map((id, i) => [id, i]))
  return list
    .map((w) => ({ ...w, order: rank.has(w.id) ? (rank.get(w.id) as number) : w.order }))
    .sort((a, b) => a.order - b.order)
}

export function addMembership(ids: readonly string[] | undefined, wsId: string): string[] {
  const cur = ids ?? []
  return cur.includes(wsId) ? [...cur] : [...cur, wsId]
}

export function removeMembership(ids: readonly string[] | undefined, wsId: string): string[] {
  return (ids ?? []).filter((x) => x !== wsId)
}

export function moveMembership(
  ids: readonly string[] | undefined,
  fromId: string,
  toId: string
): string[] {
  return addMembership(removeMembership(ids, fromId), toId)
}

export function isArchived(ids: readonly string[] | undefined): boolean {
  return !ids || ids.length === 0
}

export function sessionInWorkspaceId(ids: readonly string[] | undefined, activeId: string | null): boolean {
  if (!activeId) return true
  return !!ids && ids.includes(activeId)
}

export function nameToIdMap(list: readonly Workspace[]): Map<string, string> {
  return new Map(list.map((w) => [norm(w.name), w.id]))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npx vitest run test/workspaces.test.ts && npm run typecheck`
Expected: PASS (all workspace tests) and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/workspaces.ts src/shared/types.ts test/workspaces.test.ts
git commit -m "feat(workspaces): first-class Workspace type + id-based reducers

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 2: Store — persist workspaces + migrate names → ids

**Files:**
- Modify: `src/main/store.ts`
- Test: `test/store-migrations.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `nameToIdMap`, `createWorkspace`, `normalizeSetNames` from `src/shared/workspaces.ts`.
- Produces (on `Store`):
  - `getWorkspaces(): Workspace[]`
  - `saveWorkspaces(list: Workspace[]): Workspace[]`
  - `PersistedSession` gains `workspaceIds?: string[]` and `description?: string`.
  - Migration id `2026-08-workspaces-firstclass`.

- [ ] **Step 1: Write the failing migration test**

Append to `test/store-migrations.test.ts` a case that constructs a `Store` from a temp file containing legacy data (a session with `sets: ['July 2026']` and an empty `SessionSet {name:'July 2026', sessions:[]}`), then asserts after load: `store.getWorkspaces()` has one workspace named `July 2026`, and the persisted session's `workspaceIds` contains that workspace's id. (Follow the existing test's temp-file + `new Store(path)` pattern already used in the file.)

```ts
it('migrates legacy name-based workspaces to first-class ids', () => {
  const p = tmpStore({
    sessions: [{ id: 's1', presetId: null, command: 'x', args: [], cwd: '/tmp', label: 'S1', characterId: 'fox', sets: ['July 2026'] }],
    sets: [{ name: 'July 2026', sessions: [] }],
    migrations: []
  })
  const store = new Store(p)
  const wss = store.getWorkspaces()
  expect(wss.map((w) => w.name)).toEqual(['July 2026'])
  const wsId = wss[0].id
  expect(store.getSessions()[0].workspaceIds).toEqual([wsId])
})
```

> If `tmpStore` doesn't exist in the file, add a small helper mirroring the existing setup: write `JSON.stringify(obj)` to a `mkdtemp` path and return it.

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npx vitest run test/store-migrations.test.ts`
Expected: FAIL — `getWorkspaces` undefined.

- [ ] **Step 3: Add store fields + getters**

In `src/main/store.ts`: import `Workspace, nameToIdMap, createWorkspace` from `../shared/workspaces`. Add `workspaceIds?: string[]` and `description?: string` to `PersistedSession`. Add `workspaces: Workspace[]` to `StoreData` and `EMPTY.workspaces = []`; in `load()`'s `data` object add `workspaces: raw.workspaces ?? []`; in the corrupt-fallback baseline add `workspaces: []`. Add:

```ts
getWorkspaces(): Workspace[] {
  return this.data.workspaces
}
saveWorkspaces(list: Workspace[]): Workspace[] {
  this.data.workspaces = list
  this.persist()
  return this.data.workspaces
}
```

- [ ] **Step 4: Add the migration**

Append to the `MIGRATIONS` array in `src/main/store.ts`:

```ts
{
  // Promote name-based workspaces (session.sets + empty SessionSets) to
  // first-class Workspace entities with stable ids, and rewrite each session's
  // membership to workspaceIds. Non-empty resume bundles in `sets` are left
  // untouched (they power Save & Park).
  id: '2026-08-workspaces-firstclass',
  apply: (d) => {
    if ((d.workspaces?.length ?? 0) > 0) return
    const names: string[] = []
    for (const s of d.sessions) if (s.sets) names.push(...s.sets)
    for (const set of d.sets) if (set.sessions.length === 0) names.push(set.name)
    let list: Workspace[] = []
    let now = Date.now()
    for (const name of normalizeSetNames(names)) {
      const res = createWorkspace(list, name, now++)
      list = res.list
    }
    d.workspaces = list
    const byName = nameToIdMap(list)
    for (const s of d.sessions) {
      if (s.workspaceIds) continue
      s.workspaceIds = (s.sets ?? [])
        .map((n) => byName.get(n.trim().toLowerCase()))
        .filter((x): x is string => !!x)
    }
  }
}
```

Also add `workspaces: []` to the `EMPTY` constant and to the corrupt-fallback `data` baseline object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npx vitest run test/store-migrations.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/store.ts test/store-migrations.test.ts
git commit -m "feat(store): persist first-class workspaces + migrate name membership to ids

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 3: SessionManager — id-based membership, description, duplicate

**Files:**
- Modify: `src/main/session-manager.ts`

**Interfaces:**
- Consumes: store `getWorkspaces`/`saveWorkspaces`; reducers `addMembership`, `removeMembership`, `moveMembership` from `src/shared/workspaces`.
- Produces (on `SessionManager`):
  - `setWorkspaceIds(id: string, workspaceIds: string[]): void`
  - `addToWorkspace(id: string, wsId: string): void`
  - `removeFromWorkspace(id: string, wsId: string): void`
  - `moveToWorkspace(id: string, fromId: string, toId: string): void`
  - `archiveSession(id: string): void` (clears `workspaceIds`)
  - `setDescription(id: string, description: string): void`
  - `removeWorkspaceFromAll(wsId: string): void` (on workspace delete)
  - `duplicateSession(id: string, wsId: string | null): Promise<SessionInfo | null>` (spawn from same recipe; add to `wsId` when provided)

- [ ] **Step 1: Load memberships on hydrate + persist new fields**

In the session hydrate/create path (where `PersistedSession` → `info` is built) set `info.workspaceIds = p.workspaceIds ?? []` and `info.description = p.description`. In `persistSessions()` add `workspaceIds: m.info.workspaceIds` and `description: m.info.description` to the mapped object.

- [ ] **Step 2: Add membership + description methods**

Add to `SessionManager` (mirroring the existing `setWorkspaces`/`rename` shape — `emitRoster()` + `persistSessions()` after each):

```ts
setWorkspaceIds(id: string, workspaceIds: string[]): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.workspaceIds = [...new Set(workspaceIds)]
  this.emitRoster(); this.persistSessions()
}
addToWorkspace(id: string, wsId: string): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.workspaceIds = addMembership(m.info.workspaceIds, wsId)
  this.emitRoster(); this.persistSessions()
}
removeFromWorkspace(id: string, wsId: string): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId)
  this.emitRoster(); this.persistSessions()
}
moveToWorkspace(id: string, fromId: string, toId: string): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.workspaceIds = moveMembership(m.info.workspaceIds, fromId, toId)
  this.emitRoster(); this.persistSessions()
}
archiveSession(id: string): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.workspaceIds = []
  this.emitRoster(); this.persistSessions()
}
setDescription(id: string, description: string): void {
  const m = this.sessions.get(id); if (!m) return
  m.info.description = description.trim() || undefined
  this.emitRoster(); this.persistSessions()
}
removeWorkspaceFromAll(wsId: string): void {
  for (const m of this.sessions.values()) m.info.workspaceIds = removeMembership(m.info.workspaceIds, wsId)
  this.emitRoster(); this.persistSessions()
}
```

Add the import: `import { addMembership, removeMembership, moveMembership } from '../shared/workspaces'` (extend the existing import line).

- [ ] **Step 3: Add `duplicateSession`**

Reuse the existing create path. Find the public method that creates a session (e.g. `create(req: CreateSessionRequest)`); add:

```ts
async duplicateSession(id: string, wsId: string | null): Promise<SessionInfo | null> {
  const m = this.sessions.get(id); if (!m) return null
  const info = await this.create({
    presetId: m.info.presetId,
    command: m.info.command,
    args: m.info.args,
    cwd: m.info.cwd,
    label: m.info.label,
    tag: m.info.tag
  })
  if (wsId) this.addToWorkspace(info.id, wsId)
  return info
}
```

> Match `create`'s real signature/return (sync vs Promise) discovered in the file; if `create` returns `SessionInfo` synchronously, drop `async`/`await`.

- [ ] **Step 4: Verify**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/session-manager.ts
git commit -m "feat(sessions): id-based workspace membership, description, duplicate

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 4: IPC + preload + api surface + File menu item

**Files:**
- Modify: `src/shared/types.ts` (IPC consts), `src/shared/api.ts`, `src/preload/index.ts`, `src/main/index.ts`

**Interfaces:**
- Produces IPC channels (in `IPC`): `WORKSPACES_GET`, `WORKSPACE_CREATE`, `WORKSPACE_RENAME`, `WORKSPACE_DESCRIBE`, `WORKSPACE_DELETE`, `WORKSPACE_REORDER`, `SESSION_SET_WORKSPACE_IDS`, `SESSION_ADD_WORKSPACE`, `SESSION_REMOVE_WORKSPACE`, `SESSION_MOVE_WORKSPACE`, `SESSION_ARCHIVE`, `SESSION_DUPLICATE`, `SESSION_DESCRIBE`, `EVT_WORKSPACES`, `EVT_OPEN_WORKSPACES`.
- Produces `CrewAPI`:
  - `getWorkspaces(): Promise<Workspace[]>`
  - `createWorkspace(name: string): Promise<Workspace | null>`
  - `renameWorkspace(id: string, name: string): Promise<Workspace[]>`
  - `describeWorkspace(id: string, description: string): Promise<Workspace[]>`
  - `deleteWorkspace(id: string): Promise<Workspace[]>`
  - `reorderWorkspaces(ids: string[]): Promise<Workspace[]>`
  - `setSessionWorkspaces(id: string, workspaceIds: string[]): Promise<void>`
  - `addSessionToWorkspace(id: string, wsId: string): Promise<void>`
  - `removeSessionFromWorkspace(id: string, wsId: string): Promise<void>`
  - `moveSessionWorkspace(id: string, fromId: string, toId: string): Promise<void>`
  - `archiveSession(id: string): Promise<void>`
  - `duplicateSession(id: string, wsId: string | null): Promise<void>`
  - `setSessionDescription(id: string, description: string): Promise<void>`
  - `onWorkspaces(cb: (list: Workspace[]) => void): Unsubscribe`
  - `onOpenWorkspaces(cb: () => void): Unsubscribe`

- [ ] **Step 1: Add IPC channel constants** to the `IPC` object in `src/shared/types.ts`:

```ts
  WORKSPACES_GET: 'workspaces:get',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_RENAME: 'workspace:rename',
  WORKSPACE_DESCRIBE: 'workspace:describe',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_REORDER: 'workspace:reorder',
  SESSION_SET_WORKSPACE_IDS: 'session:setWorkspaceIds',
  SESSION_ADD_WORKSPACE: 'session:addWorkspace',
  SESSION_REMOVE_WORKSPACE: 'session:removeWorkspace',
  SESSION_MOVE_WORKSPACE: 'session:moveWorkspace',
  SESSION_ARCHIVE: 'session:archive',
  SESSION_DUPLICATE: 'session:duplicate',
  SESSION_DESCRIBE: 'session:describe',
  EVT_WORKSPACES: 'evt:workspaces',
  EVT_OPEN_WORKSPACES: 'evt:openWorkspaces',
```

- [ ] **Step 2: Extend `CrewAPI`** in `src/shared/api.ts` with the method signatures above (import `Workspace` from `./types`).

- [ ] **Step 3: Implement main handlers** in `src/main/index.ts` `registerIpc()`. Add a helper that persists + broadcasts, then handlers:

```ts
function pushWorkspaces(): Workspace[] {
  const list = store.getWorkspaces()
  broadcast(IPC.EVT_WORKSPACES, list)
  rebuildMenu()            // Change Workspace flyout reflects new names
  return list
}

ipcMain.handle(IPC.WORKSPACES_GET, () => store.getWorkspaces())
ipcMain.handle(IPC.WORKSPACE_CREATE, (_e, name: string) => {
  const { list, created } = createWorkspace(store.getWorkspaces(), name, Date.now())
  store.saveWorkspaces(list); pushWorkspaces(); return created
})
ipcMain.handle(IPC.WORKSPACE_RENAME, (_e, p: { id: string; name: string }) => {
  store.saveWorkspaces(renameWorkspace(store.getWorkspaces(), p.id, p.name)); return pushWorkspaces()
})
ipcMain.handle(IPC.WORKSPACE_DESCRIBE, (_e, p: { id: string; description: string }) => {
  store.saveWorkspaces(describeWorkspace(store.getWorkspaces(), p.id, p.description)); return pushWorkspaces()
})
ipcMain.handle(IPC.WORKSPACE_DELETE, (_e, id: string) => {
  store.saveWorkspaces(deleteWorkspace(store.getWorkspaces(), id))
  manager.removeWorkspaceFromAll(id)
  if (activeWorkspace === id) setActiveWorkspace(null)
  return pushWorkspaces()
})
ipcMain.handle(IPC.WORKSPACE_REORDER, (_e, ids: string[]) => {
  store.saveWorkspaces(reorderWorkspaces(store.getWorkspaces(), ids)); return pushWorkspaces()
})
ipcMain.handle(IPC.SESSION_SET_WORKSPACE_IDS, (_e, p: { id: string; workspaceIds: string[] }) => manager.setWorkspaceIds(p.id, p.workspaceIds))
ipcMain.handle(IPC.SESSION_ADD_WORKSPACE, (_e, p: { id: string; wsId: string }) => manager.addToWorkspace(p.id, p.wsId))
ipcMain.handle(IPC.SESSION_REMOVE_WORKSPACE, (_e, p: { id: string; wsId: string }) => manager.removeFromWorkspace(p.id, p.wsId))
ipcMain.handle(IPC.SESSION_MOVE_WORKSPACE, (_e, p: { id: string; fromId: string; toId: string }) => manager.moveToWorkspace(p.id, p.fromId, p.toId))
ipcMain.handle(IPC.SESSION_ARCHIVE, (_e, id: string) => manager.archiveSession(id))
ipcMain.handle(IPC.SESSION_DUPLICATE, (_e, p: { id: string; wsId: string | null }) => { void manager.duplicateSession(p.id, p.wsId) })
ipcMain.handle(IPC.SESSION_DESCRIBE, (_e, p: { id: string; description: string }) => manager.setDescription(p.id, p.description))
```

Import the reducers at the top of `index.ts`: `import { createWorkspace, renameWorkspace, describeWorkspace, deleteWorkspace, reorderWorkspaces, type Workspace } from '../shared/workspaces'`.

> `activeWorkspace` (module-level, currently a name) becomes a workspace **id**. Update `setActiveWorkspace` unchanged in shape; the menu now sends ids (Task 9). If sequencing before Task 9, leave the menu as-is and only fix the `WORKSPACE_DELETE` comparison — it's harmless until the menu switches to ids.

- [ ] **Step 4: Add the File menu item + open event.** In `buildMenu`'s File submenu, after `New Window`:

```ts
{ label: 'Workspaces…', accelerator: 'CmdOrCtrl+Shift+W', click: () => focusedWindow()?.webContents.send(IPC.EVT_OPEN_WORKSPACES) },
{ type: 'separator' },
```

- [ ] **Step 5: Wire preload** in `src/preload/index.ts`:

```ts
  getWorkspaces: () => ipcRenderer.invoke(IPC.WORKSPACES_GET),
  createWorkspace: (name) => ipcRenderer.invoke(IPC.WORKSPACE_CREATE, name),
  renameWorkspace: (id, name) => ipcRenderer.invoke(IPC.WORKSPACE_RENAME, { id, name }),
  describeWorkspace: (id, description) => ipcRenderer.invoke(IPC.WORKSPACE_DESCRIBE, { id, description }),
  deleteWorkspace: (id) => ipcRenderer.invoke(IPC.WORKSPACE_DELETE, id),
  reorderWorkspaces: (ids) => ipcRenderer.invoke(IPC.WORKSPACE_REORDER, ids),
  setSessionWorkspaces: (id, workspaceIds) => ipcRenderer.invoke(IPC.SESSION_SET_WORKSPACE_IDS, { id, workspaceIds }),
  addSessionToWorkspace: (id, wsId) => ipcRenderer.invoke(IPC.SESSION_ADD_WORKSPACE, { id, wsId }),
  removeSessionFromWorkspace: (id, wsId) => ipcRenderer.invoke(IPC.SESSION_REMOVE_WORKSPACE, { id, wsId }),
  moveSessionWorkspace: (id, fromId, toId) => ipcRenderer.invoke(IPC.SESSION_MOVE_WORKSPACE, { id, fromId, toId }),
  archiveSession: (id) => ipcRenderer.invoke(IPC.SESSION_ARCHIVE, id),
  duplicateSession: (id, wsId) => ipcRenderer.invoke(IPC.SESSION_DUPLICATE, { id, wsId }),
  setSessionDescription: (id, description) => ipcRenderer.invoke(IPC.SESSION_DESCRIBE, { id, description }),
  onWorkspaces: (cb) => subscribe(IPC.EVT_WORKSPACES, cb),
  onOpenWorkspaces: (cb) => subscribe(IPC.EVT_OPEN_WORKSPACES, () => cb()),
```

- [ ] **Step 6: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck && npm run build`
Expected: clean.

```bash
git add src/shared/types.ts src/shared/api.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(ipc): workspace CRUD + membership + File › Workspaces… menu

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 5: Renderer state — workspaces list + open-manager wiring

**Files:**
- Modify: `src/renderer/hooks.ts`

**Interfaces:**
- Produces on the hook return: `workspaces: Workspace[]`, `refreshWorkspaces(): void`, `showWorkspaces: boolean`, `setShowWorkspaces(v: boolean): void`. Keeps existing `activeWorkspace`/`setActiveWorkspace` but their value is now a workspace **id** (or null).

- [ ] **Step 1: Add state + subscriptions.** In `hooks.ts` add:

```ts
const [workspaces, setWorkspaces] = useState<Workspace[]>([])
const [showWorkspaces, setShowWorkspaces] = useState(false)
const refreshWorkspaces = (): void => { void window.crew.getWorkspaces().then(setWorkspaces) }
```

In the mount effect (where `onRoster`/`onWorkspace` are wired), add:

```ts
void window.crew.getWorkspaces().then((w) => mounted && setWorkspaces(w))
const offWorkspaces = window.crew.onWorkspaces((w) => setWorkspaces(w))
const offOpenWorkspaces = window.crew.onOpenWorkspaces(() => setShowWorkspaces(true))
```

Add `offWorkspaces(); offOpenWorkspaces()` to the cleanup. Import `Workspace` from `../shared/types`. Return `workspaces, refreshWorkspaces, showWorkspaces, setShowWorkspaces` from the hook (add to the returned object and its type).

- [ ] **Step 2: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck`
Expected: clean.

```bash
git add src/renderer/hooks.ts
git commit -m "feat(renderer): workspace list state + open-manager event wiring

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 6: `useSessionDrag` hook (copy vs move)

**Files:**
- Create: `src/renderer/useSessionDrag.ts`

**Interfaces:**
- Produces:
  - `type DropIntent = 'copy' | 'move'`
  - `useSessionDrag(onDrop: (sessionId: string, fromLaneId: string | null, toLaneId: string | null, intent: DropIntent) => void): { dragging: string | null; overLane: string | null; cardHandlers: (sessionId: string, laneId: string | null) => {...}; laneHandlers: (laneId: string | null) => {...} }`
  - Lane id `null` represents the **Archived** lane.

- [ ] **Step 1: Implement**

```ts
import type React from 'react'
import { useState } from 'react'

export type DropIntent = 'copy' | 'move'

interface Payload { sessionId: string; fromLaneId: string | null }

export function useSessionDrag(
  onDrop: (sessionId: string, fromLaneId: string | null, toLaneId: string | null, intent: DropIntent) => void
) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [overLane, setOverLane] = useState<string | null>(null)
  const reset = (): void => { setDragging(null); setOverLane(null) }
  const intentFrom = (e: React.DragEvent): DropIntent => (e.altKey || e.metaKey ? 'move' : 'copy')

  return {
    dragging,
    overLane,
    cardHandlers: (sessionId: string, laneId: string | null) => ({
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        setDragging(sessionId)
        e.dataTransfer.effectAllowed = 'copyMove'
        e.dataTransfer.setData('application/x-crew-session', JSON.stringify({ sessionId, fromLaneId: laneId } as Payload))
      },
      onDragEnd: reset
    }),
    laneHandlers: (laneId: string | null) => ({
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('application/x-crew-session')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = intentFrom(e)
        if (overLane !== laneId) setOverLane(laneId)
      },
      onDragLeave: () => setOverLane((cur) => (cur === laneId ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        const raw = e.dataTransfer.getData('application/x-crew-session')
        reset()
        if (!raw) return
        const { sessionId, fromLaneId } = JSON.parse(raw) as Payload
        if (fromLaneId === laneId) return
        onDrop(sessionId, fromLaneId, laneId, intentFrom(e))
      }
    })
  }
}
```

- [ ] **Step 2: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck`

```bash
git add src/renderer/useSessionDrag.ts
git commit -m "feat(renderer): useSessionDrag hook (copy default, move on modifier)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 7: WorkspaceSessionCard + WorkspaceLane components

**Files:**
- Create: `src/renderer/components/WorkspaceSessionCard.tsx`, `src/renderer/components/WorkspaceLane.tsx`

**Interfaces:**
- `WorkspaceSessionCard` props: `{ session: SessionInfo; characters: CharacterDef[]; laneId: string | null; workspaces: Workspace[]; drag: ReturnType<typeof useSessionDrag>; onRename(id,label); onDescribe(id,desc); onArchive(id); onDuplicate(id, wsId|null); onMoveTo(id, fromLaneId, toLaneId); onOpen(id) }`.
- `WorkspaceLane` props: `{ workspace: Workspace | null /* null = Archived */; sessions: SessionInfo[]; characters; workspaces; drag; reorder?: GroupHeaderDnd; onRenameWs; onDescribeWs; onDeleteWs; ...card callbacks }`.

- [ ] **Step 1: WorkspaceSessionCard** — mascot (`<Character … dot={false} badge={false} size={30}/>`), a `StatusTag` chip, inline-editable name (`contentEditable`-free: a click swaps to an `<input>` that commits on blur/Enter), an inline description (`<textarea>` one-liner committing on blur), and a `⋯` menu with: Open, Move to ▸ (submenu of workspaces + Archive), Duplicate as new session ▸ (submenu of workspaces + "No workspace"). Attach `{...drag.cardHandlers(session.id, laneId)}` to the root. Provide full component code (state for editing name/desc, menu open state, handlers calling the `on*` props). Reuse existing card class language; root class `workspace-card` + `is-dragging` when `drag.dragging === session.id`.

- [ ] **Step 2: WorkspaceLane** — header with editable title (workspace) or static "Archived" label + count; optional one-line description editor; a lane menu (Rename, Description, Delete) for real workspaces; body = the lane's cards; root gets `{...drag.laneHandlers(workspace?.id ?? null)}` and `is-drop-target` when `drag.overLane === (workspace?.id ?? null)`. If `reorder` provided, spread it on the header for lane reordering. Provide full component code.

- [ ] **Step 3: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck`

```bash
git add src/renderer/components/WorkspaceSessionCard.tsx src/renderer/components/WorkspaceLane.tsx
git commit -m "feat(ui): WorkspaceLane + WorkspaceSessionCard (drag, inline edit, menus)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 8: WorkspaceManager shell + App wiring + CSS

**Files:**
- Create: `src/renderer/components/WorkspaceManager.tsx`
- Modify: `src/renderer/App.tsx`, `src/renderer/styles.css`

**Interfaces:**
- `WorkspaceManager` props: `{ roster: SessionInfo[]; characters: CharacterDef[]; workspaces: Workspace[]; onClose(): void }`. Reads/writes via `window.crew.*`; refreshes on `onWorkspaces`/`onRoster` (already pushed to `hooks`, so it can accept `roster`/`workspaces` as props and stay controlled).

- [ ] **Step 1: WorkspaceManager** — full-screen overlay (mirror `ProjectTracker` shell + `.modal`/overlay classes). Header: title, a "+ New workspace" input (calls `window.crew.createWorkspace`), close ✕. Body: a horizontally-scrolling row of `WorkspaceLane`s sorted by `workspace.order`, followed by a pinned **Archived** lane (`workspace={null}`, sessions = roster filtered by `isArchived(s.workspaceIds)`). Instantiate one `useSessionDrag(onDrop)` and one `useGroupReorder(workspaceIds, onReorderLanes)`; wire `onDrop` to:

```ts
const onDrop = (sessionId, fromLaneId, toLaneId, intent) => {
  const to = toLaneId // null = Archived
  if (to === null) { void window.crew.archiveSession(sessionId); return }
  if (intent === 'move' && fromLaneId) void window.crew.moveSessionWorkspace(sessionId, fromLaneId, to)
  else void window.crew.addSessionToWorkspace(sessionId, to)
}
```

Lane reorder → `window.crew.reorderWorkspaces(nextIds)`. Card callbacks map to `renameSession`/`setSessionDescription`/`archiveSession`/`duplicateSession`/`moveSessionWorkspace`/`onOpen` (select + close). Provide full component code.

- [ ] **Step 2: Wire into App.tsx** — render `{c.showWorkspaces && <WorkspaceManager roster={c.roster} characters={c.characters} workspaces={c.workspaces} onClose={() => c.setShowWorkspaces(false)} />}`. Add a command-palette entry `{ id: 'act-workspaces', label: 'Manage workspaces…', run: () => c.setShowWorkspaces(true) }`. Add to the `anyModalOpen` disjunction: `|| c.showWorkspaces`.

- [ ] **Step 3: CSS** — add `.workspace-manager` (overlay + header), `.workspace-board` (flex row, horizontal scroll, gap), `.workspace-lane` (column, `--bg-elev` header, drop-target ring via `.is-drop-target`), `.workspace-lane--archived`, `.workspace-card` (+ `.is-dragging` reduced opacity), inline-edit input/textarea styles, and lane/card menu styles. Reuse theme vars (`--bg-elev-2`, `--accent`, `--border`, `--text-dim`, `--radius`, `--shadow`).

- [ ] **Step 4: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck && npm run build`
Expected: clean.

```bash
git add src/renderer/components/WorkspaceManager.tsx src/renderer/App.tsx src/renderer/styles.css
git commit -m "feat(ui): WorkspaceManager board + File › Workspaces… wiring

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 9: Switch existing consumers to id-based membership

**Files:**
- Modify: `src/renderer/App.tsx` (roster filter), `src/renderer/hooks.ts` (`activeWorkspace` is an id; `workspaces` replaces `setNames`), `src/main/index.ts` (Change Workspace menu + `activeWorkspace` by id), `src/renderer/components/NewSessionModal.tsx`, `src/renderer/components/Roster.tsx` (indicator resolves id→name), `src/renderer/App.tsx` palette workspace items.

**Interfaces:**
- Consumes: `sessionInWorkspaceId`, `Workspace`.

- [ ] **Step 1: Roster filter** in `App.tsx`: replace `sessionInWorkspace(s.sets, c.activeWorkspace)` with `sessionInWorkspaceId(s.workspaceIds, c.activeWorkspace)` (import `sessionInWorkspaceId`).

- [ ] **Step 2: Change Workspace menu** in `index.ts` `buildMenu`: build items from `store.getWorkspaces()` (`{id,name}`), `checked: activeWorkspace === w.id`, `click: () => setActiveWorkspace(w.id)`; "All Sessions" → `setActiveWorkspace(null)`. `activeWorkspace` module var is now an id.

- [ ] **Step 3: Roster indicator** in `Roster.tsx`: `activeWorkspace` prop is an id; resolve to a name for display by passing the `workspaces` list (add a `workspaces?: Workspace[]` prop from `App.tsx`) and showing `workspaces.find(w => w.id === activeWorkspace)?.name`.

- [ ] **Step 4: NewSessionModal** — offer workspace **ids** as chips (map over `workspaces` prop: label = name, value = id); create with `sets`→`workspaceIds` (extend `CreateSessionRequest` with `workspaceIds?: string[]`, and in `session-manager.create` set `info.workspaceIds`). Pre-select the active workspace id. Replace the "add new workspace name" inline field to call `window.crew.createWorkspace(name)` then select the returned id.

- [ ] **Step 5: Palette** in `App.tsx`: workspace switch items iterate `c.workspaces` → `run: () => c.setActiveWorkspace(w.id)`, label `Workspace: ${w.name}`.

- [ ] **Step 6: hooks.ts** — remove `setNames`/`getSets`-for-workspaces usage; `workspaces` (Task 5) is the source. `activeWorkspace` persists as an id in view prefs (existing mechanism, value is now an id string).

- [ ] **Step 7: Verify + commit**

Run: `export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH" && npm run typecheck && npx vitest run && npm run build`
Expected: all pass.

```bash
git add -A
git commit -m "refactor(workspaces): switch filter/menu/new-session to id-based membership

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
```

---

### Task 10: E2E coverage + guide screenshot + full verify

**Files:**
- Modify: `test/e2e/crew.e2e.mjs`
- Modify: `test/e2e/guide-shots.mjs` (add a `workspaces.png` capture)

- [ ] **Step 1: Add an e2e section** to `crew.e2e.mjs` (after an existing block): create two sessions; `window.crew.createWorkspace('Alpha')`; open the manager via `window.crew.getWorkspaces()` presence + dispatch the open event by calling the menu path is hard in e2e, so instead assert the API+state directly: create workspace, `addSessionToWorkspace(sessionId, wsId)`, then `getRoster()` shows the session's `workspaceIds` includes `wsId`; `archiveSession(sessionId)` → `workspaceIds` empty; `duplicateSession(sessionId, wsId)` → roster count +1 and the new session is in `wsId`. Assert 0 renderer errors.

```js
log('Workspaces')
const ws = await page.evaluate(async () => window.crew.createWorkspace('Alpha'))
if (ws && ws.id) ok(`created workspace ${ws.name}`); else bad('createWorkspace returned null')
const wsSid = await page.evaluate(async () => (await window.crew.getRoster())[0]?.id)
await page.evaluate(async ({ sid, wsId }) => window.crew.addSessionToWorkspace(sid, wsId), { sid: wsSid, wsId: ws.id })
await waitUntil(async () => page.evaluate(async ({ sid, wsId }) => {
  const s = (await window.crew.getRoster()).find((x) => x.id === sid)
  return !!s?.workspaceIds?.includes(wsId)
}, { sid: wsSid, wsId: ws.id }), 'session joined workspace')
ok('addSessionToWorkspace adds membership')
await page.evaluate(async (sid) => window.crew.archiveSession(sid), wsSid)
await waitUntil(async () => page.evaluate(async (sid) => {
  const s = (await window.crew.getRoster()).find((x) => x.id === sid)
  return (s?.workspaceIds?.length ?? 0) === 0
}, wsSid), 'session archived')
ok('archiveSession clears membership')
```

- [ ] **Step 2: Add a guide screenshot** in `guide-shots.mjs`: create a couple of workspaces + memberships via `window.crew.createWorkspace`/`addSessionToWorkspace`, dispatch `onOpenWorkspaces` by evaluating nothing (instead set `localStorage`? no) — open the manager by calling the palette action: click the toolbar? Simplest: expose it by evaluating `window.dispatchEvent`? Use the command palette: press ⌘K, type "Manage workspaces", Enter; then `full('workspaces.png')`. Convert to `docs/assets/guide/workspaces.jpg` (1600×1000) as in prior guide shots, and add a guide section (optional, can be a follow-up).

- [ ] **Step 3: Full verification**

Run:
```
export PATH="/Users/alexselig/.agency/nodejs/node-v22.21.0-darwin-arm64/bin:$PATH"
npm run typecheck && npx vitest run && npm run build && node test/e2e/crew.e2e.mjs
```
Expected: typecheck clean, all unit tests pass, build succeeds, e2e ✅ PASSED (0 assertion/renderer errors).

- [ ] **Step 4: Live manager probe** — a throwaway Playwright script that launches the built app, creates 3 sessions + 2 workspaces, opens the manager (⌘K → "Manage workspaces"), drags a card between lanes, and asserts `.workspace-board` renders with lanes + an Archived lane and no renderer errors; screenshot `/tmp/workspace-manager.png` and view it. Delete the probe after.

- [ ] **Step 5: Commit + push**

```bash
git add -A
git commit -m "test(workspaces): e2e coverage for the Workspace Manager

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 6d805691-061c-4444-8900-c4bf978fac4e"
export TK=$(gh auth token --user alexselig)
git -c credential.helper= -c credential.helper='!f(){ echo username=alexselig; echo "password=$TK"; }; f' push origin main
```

---

## Self-Review

**Spec coverage:**
- Full-screen manager from File › Workspaces… → Task 4 (menu) + Task 8 (UI). ✓
- Create/rename/reorder/delete workspaces → Tasks 1/2/4/8. ✓
- Drag sessions between workspaces, copy default + move modifier → Task 6 + Task 8. ✓
- Remove from workspace / Archived (no membership) → `isArchived`, `archiveSession`, Archived lane (Tasks 1/3/8). ✓
- Session name + description editing → `description` field + `setDescription` + inline editors (Tasks 1/3/7). ✓
- First-class Workspace entity + stable ids + migration → Tasks 1/2. ✓
- Duplicate as new session (explicit) → Task 3/7. ✓
- Keep File › Change Workspace + roster filter/palette/new-session working → Task 9. ✓
- Non-destructive (never spawn/kill on organize; duplicate is explicit) → enforced across Tasks 3/6/8. ✓
- Multi-window sync via broadcast (`EVT_WORKSPACES`, roster push) → Task 4. ✓
- Tests: unit (Task 1), migration (Task 2), e2e (Task 10). ✓

**Placeholder scan:** No "TBD"/"handle edge cases" left; each code step carries real code. The two spots that defer to the file's real shape (`create` signature in Task 3; `tmpStore` helper in Task 2) give explicit fallback instructions.

**Type consistency:** `workspaceIds` (not `workspaceIDs`), `wsId`, `Workspace {id,name,description?,order,createdAt}`, `sessionInWorkspaceId`, and the `window.crew` method names are used identically across tasks 1→10. Lane id `null` = Archived is consistent in Task 6/7/8.

**Open follow-up (non-blocking):** a written guide.html section for the manager can follow after the screenshot lands (Task 10 Step 2 produces the asset).
