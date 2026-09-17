# Custom session views and notification coalescing

Date: 2026-09-15
Status: Approved for implementation planning

## 1. Goals

Crew will add named custom views that let users curate and rank sessions without
changing workspace membership or the global roster order. A view can show only
its ranked sessions or show ranked sessions first followed by every unranked
session in recent order.

Crew will also stop native notification stacks from repeatedly triggering macOS
Apple Intelligence summarization. Notifications will be batched, deduplicated by
the user's unresolved interaction with each session, limited to one delivered
Crew notification at a time, and suppressed entirely while any Crew window is
foregrounded.

## 2. Non-goals

- Custom views do not launch, stop, archive, close, duplicate, or move sessions.
- Custom views do not replace workspaces, groups, Recent, Needs You, or other
  built-in presentation modes.
- Ranking does not assign priority to an agent process or affect scheduling.
- The notification change does not alter state detection or suppress the tray
  badge and menu.
- This work does not implement the durable session vault.

## 3. Product model

### Custom views

A custom view is a first-class saved entity with:

```ts
type CustomViewMode = 'curated-only' | 'ranked-plus-all'

interface CustomViewItem {
  sessionId: string
  labelSnapshot: string
}

interface CustomView {
  id: string
  name: string
  mode: CustomViewMode
  items: CustomViewItem[]
  createdAt: number
  updatedAt: number
}
```

`items` array order is the rank. Positions are always contiguous and derived
from the array index; Crew does not persist separate rank numbers.

A session may belong to multiple custom views and have a different rank in each.
Views reference Crew's full logical session ID, never provider IDs, labels,
working directories, or abbreviated ID prefixes.

`labelSnapshot` lets the organizer identify a session that is temporarily absent
from the live roster. Missing references remain in the view until the user
removes them or deletes the view. If a session with the same Crew ID returns
through recovery, it regains its existing position.

### View selection

The presentation selection becomes a discriminated value:

```ts
type SessionPresentation =
  | { kind: 'builtin'; mode: GroupMode }
  | { kind: 'custom'; viewId: string }
```

The renderer persists the selection through the existing per-window view
preference mechanism. Deleting the active custom view makes affected windows
fall back to Recent. Invalid or missing IDs also fall back to Recent rather than
showing an empty roster.

## 4. Custom-view interaction

Custom views appear in the existing view/sort picker after the built-in entries,
under a labeled **Custom views** section. The section contains every saved view
and a **New custom view** action.

Selecting a view immediately applies it to both roster and grid presentation:

- `curated-only`: show live sessions referenced by the view, in ranked order.
- `ranked-plus-all`: show referenced live sessions first, then every unreferenced
  live session in Recent order.

The selected view displays its name, mode summary, ranked count, and an
**Edit view** action. Ranking never changes session state, workspace membership,
minimized state, or the order used by another custom view.

### Two-column organizer

Creating or editing a view opens a two-column organizer:

- **All sessions**, left: searchable and filterable live roster.
- **Ranked order**, right: numbered view membership in persisted order.

The left column supports case-insensitive search across session label, working
directory, group/tag, workspace name, and agent/preset name. Filters include
workspace, session status, and agent/preset. Search and filters never hide the
right column.

Pointer interactions:

- Drag left to right to add and insert at the exact drop position.
- Drag right to right to reorder.
- Drag right to left to remove from this view only.
- Dropping an already-ranked session into the right column moves it rather than
  creating a duplicate.

Keyboard interactions provide the same outcomes:

- Move selected session into or out of the ranked column.
- Move ranked session up or down.
- Move ranked session to first or last.

The organizer edits a local draft. **Save** sends one complete replacement to
the main process. **Cancel** discards every draft change.

### View management and deletion

The organizer includes name, display mode, Save, Cancel, and **Delete view**.
Deletion requires confirmation and removes only the custom view. It never changes
or deletes sessions, workspaces, groups, transcripts, or provider history.

## 5. Persistence and IPC

`StoreData` gains `customViews: CustomView[]`, defaulting to an empty array.
Migration of existing stores adds no synthetic views and preserves every existing
field.

Store operations:

- `getCustomViews()`
- `createCustomView(input)`
- `updateCustomView(id, replacement)`
- `deleteCustomView(id)`

Validation occurs in shared, dependency-free helpers before persistence:

- IDs are stable UUIDs generated by the main process.
- Names are trimmed, non-empty, and unique case-insensitively.
- Modes must be known values.
- Session IDs must be non-empty full strings.
- Duplicate item IDs are rejected or normalized deterministically before save.
- Timestamps are finite numbers owned by the main process.

IPC operations mirror the store operations and return the resulting complete
view list. Renderer state updates only after IPC success. Failures leave the
organizer draft intact and display a visible error.

Custom-view writes use the Store's existing atomic publication, backup, and
batch semantics. There is no renderer-only persisted copy of view definitions.

## 6. Rendering and ordering

Composition is implemented as a pure shared function:

```ts
composeCustomView(
  roster: SessionInfo[],
  view: CustomView,
  now: number
): {
  sessions: SessionInfo[]
  missing: CustomViewItem[]
}
```

The function:

1. Maps the live roster by full session ID.
2. Emits each referenced live session once in item order.
3. Records unresolved items as missing without emitting placeholder sessions into
   the normal roster or grid.
4. For `ranked-plus-all`, appends unreferenced sessions using the existing Recent
   ordering function.

The organizer renders missing items on the right as **Unavailable**, retaining
their label snapshot and rank. Users may remove them manually.

Built-in grouping and drag behavior remain unchanged. Custom-view dragging is
active only in the organizer so ordinary roster dragging cannot accidentally
rewrite a custom ranking.

## 7. Notification root cause and policy

Observed on 2026-09-15:

- `suggestd` consumed approximately 87% CPU.
- Unified logs contained 61 processing records for
  `app: com.alexselig.crew` over roughly three minutes.
- The records represented only three notification hashes and repeated
  notification-stack summarization work in approximately five-second jobs.
- Crew currently creates a new Electron `Notification` for every transition
  from a non-needs-you state into a needs-you state.
- Terminal redraws can temporarily move a detector from waiting to working and
  back to waiting without the user responding.
- Many sessions finishing together can each create a separate notification.

The fix belongs in a notification coordinator owned by `CrewTray`. State
detection remains unchanged.

### Notification coordinator

The coordinator maintains:

- `announcedSessionIds`: sessions already announced since their last user input.
- `pendingSessions`: newly eligible waiting sessions being batched.
- `batchTimer`: one one-second coalescing timer.
- `activeNotification`: the one Electron notification Crew currently owns.

When Crew receives an eligible needs-you transition:

1. If any Crew `BrowserWindow` is focused, mark the session announced for this
   wait cycle without showing a native notification.
2. Otherwise, ignore it if that session is already announced or pending.
3. Add the latest session snapshot to the pending batch.
4. Start the one-second timer if it is not already running.

When the timer fires:

1. Move pending IDs into `announcedSessionIds`.
2. Close and release the previous `activeNotification`.
3. Show exactly one new notification:
   - One session: existing character, label, and input/approval body.
   - Multiple sessions: `Crew` title and `<N> sessions need you` body.
4. Clicking a single-session notification jumps to that session.
5. Clicking an aggregate notification reveals Crew without choosing a session.

The main process calls `acknowledgeSession(id)` when the user sends input to that
session. This removes the ID from `announcedSessionIds`, allowing a later genuine
needs-you episode to notify again. Detector output, silence, redraws, and state
oscillation do not re-arm notifications.

Foreground suppression does not create a delayed alert when Crew later loses
focus. That wait cycle is treated as already announced and only re-arms after
real `SESSION_INPUT`.

Roster reconciliation removes pending/announced IDs for sessions no longer on
the roster. Destroying the tray cancels the timer, clears state, closes the
active notification, and prevents late callbacks.

The tray title, tooltip, context menu, and renderer attention states continue to
update for every roster change even when native notification delivery is
deduplicated.

## 8. Failure behavior

- A failed custom-view save is visible and leaves the draft editable.
- A missing selected view falls back to Recent.
- A missing session does not invalidate or delete a custom view.
- Deleting a custom view cannot delete any session data.
- Notification APIs being unsupported remain a silent capability absence.
- Closing/replacing a notification is best-effort; a failure must not affect the
  tray badge or session state.
- A notification callback after tray destruction is ignored.

Existing notification stacks delivered by older Crew versions may remain in
Notification Center until the user clears them. The new coordinator prevents
Crew from continuing to create an unbounded stack.

## 9. Test contract

### Custom views

- Store migration defaults `customViews` without changing existing data.
- Create, rename, update-mode, reorder, and delete round-trip through Store.
- Blank and case-insensitive duplicate names are rejected.
- Duplicate session IDs cannot survive save.
- Curated-only emits only ranked live sessions.
- Ranked-plus-all appends unranked sessions in Recent order.
- Missing items retain rank and label snapshot in organizer data.
- Deleting the active view falls back to Recent.
- Search covers label, cwd, group, workspace, and preset.
- Pointer drag covers add-at-position, reorder, and drag-back removal.
- Keyboard controls cover add/remove and first/up/down/last movement.
- Cancel causes no IPC write; Save sends one replacement.
- Custom ranking does not mutate global roster or workspace membership.

### Notifications

- Fifty transitions inside one batch produce one aggregate notification.
- Repeated working/waiting oscillation for one session produces one notification
  until user input.
- Foregrounded Crew windows suppress native notification delivery while still
  consuming that session's current wait cycle.
- Background delivery still produces the native alert normally.
- User input re-arms only that session.
- A later batch closes/replaces the previous notification.
- Single-session notification retains jump behavior.
- Aggregate click reveals Crew.
- Removing sessions reconciles pending and announced sets.
- Destroy cancels pending delivery and closes the active notification.
- Unsupported notifications do not throw.

### Verification

- Focused unit and renderer tests.
- Full unit suite.
- Main and renderer typechecks.
- Production Electron build.
- Electron E2E covering custom-view creation, search, drag insertion, persisted
  order after relaunch, deletion fallback, and zero renderer/main-process errors.
- A local notification stress harness verifies that fifty synthetic transitions
  yield one native notification request rather than fifty. It must not clear or
  modify unrelated system notifications.

## 10. Delivery boundaries

Implement as separate logical commits:

1. Notification batching and deduplication with tests.
2. Custom-view model, Store migration, validation, IPC, and pure composition.
3. Custom-view picker and two-column organizer with pointer and keyboard access.
4. E2E coverage and directly related documentation.

Do not bump the application version or publish a release as part of these
commits. Release preparation happens only after the user finishes selecting the
next feature set.
