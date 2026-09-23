# Nav navigation, custom-view ordering, and the view menu

**Date:** 2026-09-23
**Status:** designed, implemented on `feat/nav-navigation-and-custom-view-ordering`

Four requests, treated as four independent changes. Each one was reproduced or
traced to a specific line before anything was written; the root causes turned
out to be unrelated to each other, so they are separable and independently
revertible.

---

## 1. Clicking in the nav should navigate you to the session

### What is actually wrong

The roster is the **only** navigation surface in the app that does not use the
shared navigation routine.

| Surface | Handler | Goes through |
| --- | --- | --- |
| "Needs you" button | `focusSession` | `navigateToSession` |
| Grid tile expand | `onExpand={focusSession}` | `navigateToSession` |
| Jump IPC (`onJump`) | `navigateToSession` | `navigateToSession` |
| Command palette | `focusSession` | `navigateToSession` |
| **Roster / nav click** | **`onSelect={c.selectSession}`** | **nothing — bare selection** |

`App.tsx:375`. `selectSession` only reveals the session and sets `selectedId`.
`navigateToSession` (`session-navigation.ts`) additionally:

- clears the workspace filter when the target is not in the active workspace,
- falls back to the Recent view when the active custom view does not contain
  the target, and
- calls `setShowNew(false)`.

So a nav click leaves stale filter state behind and, unlike every other entry
point, cannot dismiss the new-session panel.

### Decision

Pass `c.navigateToSession` as the roster's `onSelect`. The nav then has
identical semantics to every other "go to this session" affordance.

`GridView`'s `onSelect` is deliberately left alone — in the grid, selection
means "highlight this tile", and `onExpand` is already the navigation verb.

### The assumption, stated plainly

The request said "navigates you to the **right window** (session)". Crew does
run multiple `BrowserWindow`s, so this could have meant *raise the window that
already has that session*. **It cannot mean that today**: `openWindow()`
(`main/index.ts:364`) creates a generic window, and no session→window ownership
is recorded anywhere, so there is no "right window" to route to. Building that
would mean introducing a session-ownership model across the main process — a
separate, much larger feature.

This change implements the in-window reading, which is backed by a real
inconsistency in the code. If the cross-window reading was intended, that is
still open.

---

## 2. Reordering items in the nav inside a custom view

### What is actually wrong

`Roster.tsx:219` disables card drag-and-drop outright whenever a custom view is
active:

```ts
useCardDnd(roster, railed || presentation.kind === 'custom' ? 'disabled' : groupMode, …)
```

So the one view type whose whole purpose is a hand-picked order was the one
view you could not reorder by hand.

### Decision

Enable dragging in custom views and route the drop to the **view**, not to the
global roster order. Reusing `window.crew.reorder` would have been wrong: that
rewrites the global session order, which every other view shares.

`shared/custom-views.ts` already exports `moveIntoView` with exactly the right
semantics, so the drop is expressed as a *move*, not as a whole-list rewrite:

- drop onto a ranked session → `moveIntoView(ids, dragId, indexOfTarget)`,
  direction-preserving, matching the existing `moveNextTo` behaviour;
- drop onto an unranked session (`ranked-plus-all` only) → the dragged session
  is appended to the end of the ranked block, i.e. dragging an unranked session
  into the list **pins** it.

`useCardDnd` gains an optional `onMove(dragId, targetId)`. When supplied it
replaces `onReorder`, so the existing whole-list path is untouched.

Persisted with `updateCustomView`; new items carry a `labelSnapshot` taken from
the session's current label, the same as every other insertion path.

---

## 3. The overlapping button in the view menu

### What is actually wrong — measured, not guessed

Reproduced in a static page built from the real `styles.css` and the real
`GroupPicker` markup, at the real 280px sidebar width:

```
roster : { l:    0, r: 280, w: 280 }
menu   : { l: -264, r:  40, w: 304 }
menuOverflowsRosterBy : 264
editOverflowsMenuBy   :  -1
customOverlapsEdit    :  -6
```

The menu's left edge is at **x = −264** — 264px off the left edge of the
window. The *internal* layout is fine (both overlap figures are negative); the
defect is purely horizontal positioning.

The cause: the picker button sits at the left end of `.roster__tools`, the menu
is anchored `right: 0` and therefore grows **leftward**, and the `EDIT VIEW`
button widens the menu from ~150px to 304px. So the menu escapes the window
precisely when a custom view is active — which is exactly when `EDIT VIEW`
renders. What reaches the screen is a clipped menu with `EDIT VIEW` jammed
against the edge.

`GroupPicker` already has a **vertical** flip (`dropUp`, for the same class of
problem at the bottom of the screen). It has no horizontal equivalent.

### Decision

Add the missing horizontal flip, mirroring `dropUp`:

- compute the *hypothetical* left edge as `anchor.right − menuWidth` rather
  than reading the menu's current position, so the result does not depend on
  the flip already applied and cannot oscillate;
- when that is off-screen, anchor `left: 0` and let the menu open rightward;
- additionally cap the menu with `max-width: min(320px, calc(100vw - 16px))`
  and allow the view name to ellipsize, so one long custom-view name cannot
  reintroduce the problem.

---

## 4. A "group by" toggle for custom views

### Decision

`CustomView` gains `groupBy?: 'none' | 'recent'`.

- **Optional**, so every already-stored view keeps working and there is no
  migration. `undefined` reads as `'none'` — the current behaviour, plain list
  order.
- `'recent'` reuses `groupSessions(sessions, 'recent', …)` from
  `renderer/grouping.ts` **unchanged**, so the buckets are literally the same
  ones the built-in "By recent" view uses (`Last 30 min` / `Last 2 hrs` /
  `Last day` / `Last week+`, with the rank-based fallback and the stable
  within-bucket slotting). The request asked for "groups matching recency
  grouping"; sharing the function is the only way to guarantee that stays true.

Note the interaction with §2: under `groupBy: 'recent'` the view's manual order
no longer determines what you see, because the buckets are derived from
`lastPromptAt`. Manual order is preserved in the stored items and returns the
moment you switch back to `'none'`; dragging is disabled while grouping is on,
rather than silently discarding the drop.

### Where the toggle lives

In the **custom view editor** (`CustomViewOrganizer`), beside the existing
`mode` control — not in the `GroupPicker` flyout. The flyout is the surface
that was just shown to overflow the window in §3; widening it further with a
per-view control would reintroduce that defect. The editor is also where every
other per-view setting already lives.

### Threading it through

`normalizeCustomViewInput` rebuilds the input object field by field and drops
anything unknown, so `groupBy` has to be added in four places or it silently
will not persist: `CustomViewInput`, `normalizeCustomViewInput`,
`createCustomView`/`updateCustomView`, and `isCustomView` (which validates what
is read back off disk, and must tolerate the field being absent).

---

## Verification

- `npm run typecheck` clean; `npx vitest run` **816 passing / 79 files**;
  `npm run build` green (1,790.29 kB).
- **§3 re-measured in the harness that reproduced it.** The menu's left edge
  moved from **−264 → +14**, i.e. fully on-screen, with the width capped at
  304px:

  ```
  before  menu: { l: -264, r:  40, w: 304 }   menuOverflowsRosterBy:  264
  after   menu: { l:   14, r: 318, w: 304 }   menuOverflowsRosterBy:  -14
  ```

  A deliberately over-long view name ("Everything I am currently shipping this
  week") stays inside the cap rather than re-widening the menu.
- New unit tests, `environment: 'node'`:
  - `test/custom-view-reorder.test.ts` (10) — drop direction, pinning an
    unranked session, label-snapshot handling, no duplication, no mutation.
  - `test/custom-view-groupby.test.ts` (6) — default, persistence across a
    reload, update round-trip, **a view stored before `groupBy` existed still
    loads**, and an unknown value being refused.
- Two browser contract tests replace the old
  "disables ordinary roster and grid drag while a custom view is active":
  roster drag is now *enabled* in a custom view (grid still disabled), and is
  disabled again once the view groups by recency.

### Known consequence, accepted

`isCustomView` rejects an unrecognised `groupBy`, and the store treats any
invalid view as a corrupt `customViews` array — which disables saving until
repaired. That means a store written by a future Crew with a third `groupBy`
value would not load here. This is the pre-existing policy for `mode` and every
other validated enum, so it is left consistent rather than special-cased; it is
recorded here because the test that pins it looks alarming out of context.
