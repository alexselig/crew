# Left-nav clicks put the session in the grid's left column

**Date:** 2026-09-23
**Status:** implemented

## The request

> Can we have clicking the left nav bring the session window into focus as the
> leftmost item or column

## What was wrong

The grid scrolls horizontally. A fixed number of rows fills the height, tiles
flow into columns, and two columns are visible at a time
(`styles.css`, `.gridview--two/--four/--six .gridview__scroll`).

`GridView` kept the selected tile on screen with:

```ts
el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
```

`inline: 'nearest'` moves the viewport as little as possible. Picking a session
from the nav therefore landed it in the **right** column, or — if its tile was
already partly on screen — did not scroll at all. The session you asked for
arrived at the far edge of your attention instead of the near one.

Measured in the harness before the change: clicking `b5` in the nav left its
tile **6377px** from the scroller’s left edge. After: **0px**.

## What it does now

A click in the left nav aligns that session's tile to the grid's left edge.
Clicking a tile in the grid still does not move the layout.

Scrolling only. Nothing is reordered. The session keeps its place in the list,
which matters because 0.7.2 had just made drag order in a custom view
meaningful — a click that silently re-ranked sessions would fight that.

## Why a request object rather than reading selection

Clicking a nav row and clicking a tile both end at `setSelectedId`, so selection
alone cannot say *why* a session became selected. The two paths are already
distinct one level up:

| Surface | Handler | Alignment |
|---|---|---|
| Left nav (`Roster`) | `c.navigateToSession` | `start` — left edge |
| Command palette, external jump | `c.navigateToSession` | `start` — left edge |
| Grid tile | `c.selectSession` | `nearest` — minimal movement |

`navigateToSession` now records `{ id, seq }`. `GridView` aligns to `start` only
while that request names the currently selected session.

The sequence number exists so that navigating to the session that is *already*
selected still re-aligns it: the id alone would not change, so the effect would
not re-run and clicking the same nav row twice would do nothing the second time.

The request deliberately collapses to no effect key when it names some other
session (`revealKey` returns `null`). Without that, navigating to one session
would bump the key for a different selected session and re-scroll something the
user never asked for.

## Components

- **`src/renderer/reveal.ts`** — the whole decision, as three pure functions
  (`isDeliberateReveal`, `revealInline`, `revealKey`). No DOM, no React, so the
  rules are unit-testable on their own.
- **`src/renderer/hooks.ts`** — owns `revealRequest` state; `navigateToSession`
  bumps it. Exposed on `CrewState`.
- **`src/renderer/components/GridView.tsx`** — consumes it in the existing
  scroll effect. The effect is otherwise unchanged and still handles the
  incidental case it was written for (the selected session re-buckets and its
  tile moves).

`revealRequest` is an optional prop, so a `GridView` rendered without it behaves
exactly as before.

## Known limits, accepted

- **The final column cannot reach the left edge.** With two columns visible,
  aligning the last session left would require scrolling past the end of the
  content, so the browser clamps and it settles in the right column. This is
  correct and not worth special-casing — the alternative is padding the strip
  with empty space. The regression test targets `b5` rather than the last
  session `b9` for exactly this reason, and says so.
- **The reveal is not cleared after it is consumed.** A stale request is
  harmless: it only has an effect while it names the selected session, and any
  later selection change either replaces it or makes it inert. Clearing it would
  need a second state write per navigation for no behavioural difference.

## Testing

- `test/reveal.test.ts` — 7 unit tests over the pure rules, including the two
  cases that are easy to get wrong: a stale request must not left-align a
  different session, and re-navigating to the selected session must re-align.
- `test/renderer-regressions.test.ts` — two tests in the headless browser
  harness driving the **real** `Roster` and `GridView` against a new `reveal`
  fixture, asserting real `getBoundingClientRect()` geometry:
  - a nav click leaves the tile within 2px of the scroller's left edge;
  - clicking an already-visible tile leaves `scrollLeft` untouched.

  Both were confirmed to fail with the old `inline: 'nearest'` before the fix
  was restored.

The existing `app` fixture could not be used: it stubs `Roster` and `GridView`
to isolate App's state logic. The new `reveal` fixture renders the real
components with 18 sessions so the grid genuinely scrolls. Its sessions are
exited, so tiles render without standing up 18 live terminals.

Full suite: 825 tests / 80 files passing.
