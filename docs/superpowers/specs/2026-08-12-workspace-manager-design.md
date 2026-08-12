# Workspaces as first-class organization — a Workspace Manager UI

**Status:** Design proposal — awaiting review
**Date:** 2026-08-12
**Author:** brainstorming session (user unavailable; decisions made autonomously with rationale, to review)

## Summary

Make **workspaces** a first-class way to organize Crew sessions at a macro level.
Add a dedicated **Workspace Manager** — a full-screen board opened from **File ›
Workspaces…** — where you can create workspaces, drag sessions between them,
give each session a **name and description**, and see an **Archived** bucket of
sessions that belong to no workspace. Dragging a session into a workspace is
**non-destructive by default** (it stays wherever it already was), because a
Crew session is a single live process that can belong to many workspaces at once.

This builds directly on Crew's existing workspace foundation (named, multi-
membership "sets" filtered non-destructively via File › Change Workspace) and
promotes it from an ad-hoc tag into a managed, first-class entity.

## Background: what exists today

- A session already carries multi-workspace membership: `SessionInfo.sets?:
  string[]` (a session can be in many workspaces). Filtering by the active
  workspace is non-destructive — hidden sessions keep running.
  (`src/shared/workspaces.ts`, `src/renderer/App.tsx` roster filter.)
- Workspaces are keyed by **name** (a string), and the store conflates two
  different ideas in one `sets: SessionSet[]` array: **resume bundles** (the
  "Save & Park" launch templates) *and* **workspace-name registration** (a
  `SessionSet` with an empty `sessions` list is really just "a workspace that
  exists"). (`src/main/store.ts`.)
- Sessions have a `label` (name) but **no description**. (`src/shared/types.ts`.)
- The only workspace UI is a **filter**: File › Change Workspace (a radio flyout)
  + a clearable indicator in the roster + command-palette switching. There is no
  place to *organize* sessions across workspaces.
- Reusable building blocks already exist: an HTML5 drag hook
  (`src/renderer/useGroupReorder.ts`), an ordered one-time store-migration
  framework (`src/main/store.ts` `MIGRATIONS`), and full-screen dialog
  precedents (`ProjectTracker.tsx`, `SettingsModal.tsx`, `TranscriptsModal.tsx`).

## Goals

- A first-class **Workspace Manager** UI, opened from **File › Workspaces…**.
- **Create / rename / reorder / delete** workspaces.
- **Drag sessions** between workspaces. Default drag = **add** (non-destructive);
  an explicit **Move** (remove from source) via modifier / right-click.
- **Remove a session** from a workspace; a session in **no** workspace is
  **Archived** and appears in a dedicated Archived lane.
- Edit a session's **name and description** inline.
- Everything is non-destructive to the live process — organizing never spawns or
  kills an agent. (Closing a session stays a separate, explicit action.)

## Non-goals (YAGNI)

- Cloning a running agent into a brand-new process on drag (see "Copy vs link").
  A separate, explicitly-labeled **"Duplicate as new session"** action covers the
  rare true-clone case; it is not the drag default.
- Nested/hierarchical workspaces, per-workspace window layouts, sharing/export,
  multi-select drag, and per-workspace colors. (Colors/description-on-workspace
  are cheap and noted as optional; not required for v1.)

## Key decision: "copy" vs "link" vs "move" (the crux)

A Crew session is a live PTY + a running agent conversation, so it cannot be
duplicated the way a file can. The request said "by default it will copy them"
and "copy or link to same session." We reconcile those words as follows, and
this is the **primary decision to confirm**:

- **Copy (the default drag) = add membership.** The session now appears in the
  target workspace *and* stays in its source(s). Under the hood this is the
  *same* live session shown in two places — i.e. the user's "copy" and "link to
  the same session" are the **same operation** viewed two ways. Dragging never
  starts or stops a process.
- **Move = add to target, remove from source.** Available via ⌘/Alt-drag or the
  card's right-click menu, for when you actually want to relocate a session.
- **Archive = remove from all workspaces.** Dragging a card to the **Archived**
  lane (or "Archive" in its menu) clears its memberships. The session keeps
  running; Archive is purely organizational.
- **Duplicate as new session** (explicit menu action, *not* drag) = spawn a fresh
  session reusing the dragged one's recipe (preset / cwd / command / character)
  in the target workspace. This is the only path that creates a new process, and
  it is never the default.

> If you actually want drag-to-copy to *clone the process* by default, that's
> "Approach B" below and this section flips — flag it on review.

## Approaches considered

### Data model

**Approach 1 — Stable workspace ids (recommended).** Introduce a first-class
`Workspace = { id, name, description?, order, createdAt }` persisted in a new
`StoreData.workspaces: Workspace[]`. Session membership moves from name-based
(`sets: string[]`) to id-based (`workspaceIds: string[]`). A one-time migration
creates a `Workspace` per existing distinct name and rewrites each session's
membership. *Pros:* rename/reorder are trivial and safe (membership is by id, so
renaming a workspace touches one record, not every session); untangles the
store's resume-bundle vs workspace conflation; the natural "first-class" shape.
*Cons:* a data migration + touching every membership read/write site once.

**Approach 2 — Keep name-keyed membership, add metadata.** Leave `session.sets:
string[]` as-is; add a `workspaces: Workspace[]` list keyed by name for
description/order only. *Pros:* no membership migration; smallest diff. *Cons:*
renaming a workspace must rewrite every session's `sets` (fragile, the exact
problem a manager surfaces); name stays the identity, so two ideas keep sharing
one string; doesn't really make workspaces first-class.

**Recommendation: Approach 1.** A management UI's whole job is rename/reorder/
organize; name-as-identity fights that. The migration is a bounded, one-time,
well-supported operation.

### UI shape

**Approach A — Kanban board (recommended).** A full-screen board with one lane
per workspace plus a pinned **Archived** lane. Each lane holds session cards
(character, name, live status, description). Drag cards between lanes; drag lane
headers to reorder; "+ New workspace" adds a lane. This is the most direct
match for "drag sessions into workspaces" and shows the whole macro picture at a
glance (including what's archived). Mirrors the full-screen `ProjectTracker`.

**Approach B — Two-panel (list + detail).** Left: workspace list (+ Archived).
Right: sessions in the selected workspace, with an "add session" picker. *Pros:*
simpler, no cross-lane drag. *Cons:* you can't see or drag across the whole
board at once; weaker for the stated "drag between workspaces" goal.

**Recommendation: Approach A (kanban board).**

## Design

### Components (isolated, single-purpose)

- **`WorkspaceManager.tsx`** — the full-screen dialog shell (overlay, header with
  "+ New workspace" and close, horizontally-scrolling lane row). Owns board-level
  state and wires IPC. Opened by a `File › Workspaces…` menu event.
- **`WorkspaceLane.tsx`** — one workspace column: editable title + optional
  description, session count, reorder drag handle (reuses `useGroupReorder`), a
  drop target for session cards, and a lane menu (rename, delete). A special
  read-only **Archived** lane variant (no rename/delete; is a drop target).
- **`WorkspaceSessionCard.tsx`** — a draggable session card: character mascot,
  status chip, inline-editable name + description, and a right-click/⋯ menu
  (Move to ▸, Archive, Duplicate as new session, Open, Close). Reuses existing
  card visual language.
- **`useSessionDrag.ts`** — a small hook encapsulating card drag: sets the
  dragged session id on `dataTransfer`, reads the modifier to choose copy vs
  move, and exposes drop handlers that call the membership mutators. (Sibling to
  `useGroupReorder`, which handles lane-header reordering.)
- **`workspaces.ts` (shared, extended)** — pure reducers/helpers so all mutation
  logic is unit-testable without Electron: `addMembership`, `removeMembership`,
  `moveMembership`, `isArchived`, `createWorkspace`, `renameWorkspace`,
  `deleteWorkspace`, `reorderWorkspaces`, and the name→id migration mapping.

### Data model changes

```ts
// shared/types.ts
export interface Workspace {
  id: string            // stable, e.g. `ws_${nanoid}`
  name: string
  description?: string  // optional workspace note (cheap; not required by user)
  order: number         // display order in the board
  createdAt: number
}

// SessionInfo gains:
  description?: string       // NEW: freeform session note, editable in the manager
  workspaceIds?: string[]    // NEW: membership by workspace id (replaces name-based `sets`)
  // `sets?: string[]` is retained only for reading legacy/resume payloads; the
  // migration populates workspaceIds and it is no longer the membership source.
```

Store: add `StoreData.workspaces: Workspace[]`. The resume-bundle `sets:
SessionSet[]` stays exactly as-is (it powers Save & Park / resume and is
orthogonal to organization) — we simply stop using empty `SessionSet`s as
workspace registration.

**Migration `2026-08-workspaces-firstclass`** (ordered, id-recorded):
1. Collect every distinct workspace name from `session.sets` ∪ empty
   `SessionSet.name`s (case-insensitive, first spelling wins — reuse
   `normalizeSetNames`).
2. Create a `Workspace` for each, assigning `order` by first-seen and a fresh id.
3. For every session, set `workspaceIds` = ids of its old `sets` names.
4. Drop the empty workspace-registration `SessionSet`s (keep non-empty resume
   bundles).

### Data flow & IPC

Main owns the store and broadcasts changes to all windows (mirrors existing
roster/workspace events). New channels (names illustrative):

- `WORKSPACES_GET` → `Workspace[]`
- `WORKSPACE_CREATE {name}` → the new `Workspace`
- `WORKSPACE_RENAME {id, name}` · `WORKSPACE_UPDATE {id, description}`
- `WORKSPACE_DELETE {id}` (members become archived — memberships removed, not the
  sessions)
- `WORKSPACE_REORDER {ids}`
- Membership: reuse/extend `SESSION_SET_WORKSPACES {id, workspaceIds}` (replace
  set), plus thin `SESSION_ADD_WORKSPACE` / `SESSION_REMOVE_WORKSPACE` for
  single-edge drag/move.
- Session fields: `SESSION_UPDATE {id, label?, description?}` (extends the
  existing rename path to also carry description).
- Broadcasts: `EVT_WORKSPACES` (list changed) and the existing roster push (so
  membership/description edits reflect everywhere, including the roster filter and
  the File › Change Workspace flyout, which now lists managed workspaces).

The roster filter, New Session modal, and Change Workspace flyout switch from
name-based to id-based membership but keep their current behavior. "All Sessions"
still shows everything (including archived); each workspace shows its members;
**Archived** is the derived view of sessions with empty `workspaceIds`.

### Interactions

- **Create workspace:** "+ New workspace" adds a lane with an inline-editing
  title; empty name is discarded on blur.
- **Rename / describe:** click the lane title/description to edit inline.
- **Reorder workspaces:** drag lane headers (`useGroupReorder`) → `WORKSPACE_REORDER`.
- **Delete workspace:** lane menu → confirm if it has members → members archived.
- **Drag session:** card → lane = **copy/add** (default); ⌘/Alt-drag or menu →
  **Move**; drag to **Archived** = remove from all workspaces.
- **Edit session name/description:** inline on the card.
- **Per-session menu:** Move to ▸, Archive, Duplicate as new session, Open
  (focus in main window), Close (existing destructive path, with its usual guard).

### Error handling & edge cases

- **Duplicate names:** allowed to differ only by identity (ids), but the create/
  rename path blocks a case-insensitive duplicate of an existing name to avoid
  confusing menus (reuse `normalizeSetNames` semantics).
- **Delete with members:** confirmation; sessions are archived, never closed.
- **Last-membership removal** auto-archives (by definition — empty `workspaceIds`).
- **Multi-window concurrency:** all mutations go through main and broadcast, so a
  second window's board and the roster stay in sync.
- **Migration idempotency:** guaranteed by the id-recorded migration framework.
- **Exited/errored sessions** still appear (archived or in their workspace) so you
  can organize or dismiss them; status chips reflect state.

### Testing

- **Unit (pure `shared/workspaces.ts`):** add/remove/move membership; `isArchived`;
  create/rename/delete/reorder reducers; name→id migration mapping; duplicate-name
  guarding. (Extends the existing `test/workspaces.test.ts`.)
- **Store:** migration test (legacy `sets` names → `workspaces` + `workspaceIds`,
  empty resume-bundles dropped, non-empty kept) in the migrations test suite.
- **E2E (`test/e2e/`):** open File › Workspaces…, create a workspace, drag a
  session into it, verify membership + roster filter, move, archive (drag to
  Archived), rename, delete-with-members → archived. Add a guide screenshot lane
  to the guide-shots harness.

## Open questions to confirm on review

1. **Copy vs clone (primary):** Confirm the default drag is non-destructive
   **membership add** (Approach as written), with process-cloning only via the
   explicit "Duplicate as new session" action — *not* the drag default.
2. **Data model:** OK to introduce stable workspace **ids** + a one-time
   migration (Approach 1), rather than staying name-keyed (Approach 2)?
3. **Workspace descriptions:** you asked for descriptions on *sessions*; do you
   also want an optional description on each *workspace*? (Cheap; included as
   optional above — say the word to drop it.)
4. **Menu:** keep both **File › Workspaces…** (manager) and **File › Change
   Workspace** (quick filter), or fold the switcher into the manager?
