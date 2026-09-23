# Terminal panes: wrong-place status lines, and drops that stop working

Two independent defects, both reported as "it breaks for one session and stays
broken". Both were reproduced before being fixed, and the numbers below are
measurements, not estimates.

## 1. Degenerate sizes were forwarded to the live PTY

`CrewTerminal` and `TerminalView` fit the terminal on every `ResizeObserver`
callback and forwarded the result to the PTY. That is correct right up until the
mount is laid out at zero.

A collapsed mount does not fail loudly. `FitAddon.proposeDimensions()` ends with:

```js
cols: Math.max(2, Math.floor(availableWidth  / cellWidth)),
rows: Math.max(1, Math.floor(availableHeight / cellHeight))
```

so it returns a *plausible* size rather than an error. Only `display: none` is
safe, because `getComputedStyle().height` is then `auto`, `parseInt` gives `NaN`,
and `fit()` discards it. Every other way a pane reaches zero — a collapsed
split, a pane mid-transition, a window being restored, a tab laid out at zero
height — sails straight through.

Driving the real `@xterm/addon-fit` against a 920x420 mount:

| Step | Size sent to the PTY |
| --- | --- |
| normal layout | 125 x 24 |
| mount height set to `0px` | **125 x 1** |
| height restored | 125 x 24 |
| mount width set to `0px` | **2 x 24** |
| width restored | **129 x 24** — while a fresh proposal said **125** |

The middle rows are the bug the user sees. An agent told it has one row redraws
its entire interface into that row, and the damage outlives the moment: it keeps
drawing to a geometry that no longer exists, which is how a status line ends up
stranded in the middle of a pane long after the pane is the right size again.

### The second defect in the same table

The last row is a separate problem: **one fit pass does not converge.** FitAddon
subtracts the viewport scrollbar width, but whether a scrollbar exists depends
on the size being proposed, so the value read during a collapsed frame is stale.
The terminal settled at 129 columns in a container that fits 125, and nothing
re-fits afterwards — so right-aligned output is drawn past the visible edge and
a horizontal scrollbar appears under the pane.

### Fix

`src/renderer/terminal/fit-guard.ts` decides, DOM-free so it can be tested:

- **Refuse** when the mount is not laid out (detached, or zero width/height).
- **Refuse** FitAddon's clamp floors (<= 2 cols, <= 1 row) and non-finite values.
- **Refuse** when the mount is too short for even one row, rather than rounding
  down to one.
- Otherwise cap rows to the mount's true content height, as before.

`XtermEngine.fit()` now returns `FitResult | null` and **never calls
`FitAddon.fit()`**, because that applies its own proposal before anyone can
inspect it. It calls `proposeDimensions()`, checks it, and iterates to a fixed
point (max 3 passes) to absorb the scrollbar-width feedback. Both call sites
skip the `window.crew.resize` IPC entirely on `null`, keeping the PTY's last
good size — the `ResizeObserver` fires again when the mount regains a real size,
so refusing costs nothing.

Re-running the same browser harness against the shipped guard:

| Step | Before | After |
| --- | --- | --- |
| height -> 0 | `resize(125, 1)` | **refused** |
| width -> 0 | `resize(2, 24)` | **refused** |
| width restored | `resize(129, 24)` | `resize(125, 24)`, converged |

## 2. A stranded drop overlay blanked the pane

The drop overlay was driven by a depth counter, and **every handler returned
early when the payload did not advertise `Files` — including the drop handler,
which was the only thing that reset the counter**:

```js
function onDrop(e) {
  if (!hasFiles(e)) return   // depth and overlay never reset
```

Any unbalanced `dragenter`/`dragleave` pair therefore stranded the counter above
zero. `.term-drop__overlay` is `position: absolute; inset: 6px; z-index: 5` with
a tint and `pointer-events: none`, so a stranded one sits over the terminal: the
pane looks blank, and no later drag on it can succeed. The counter is per pane,
which is exactly why one session breaks while its neighbour is fine.

Pairs go unbalanced routinely — the drag is cancelled with Esc, it leaves the
window, it is dropped on another element, or the drop's `dataTransfer` does not
advertise `Files`.

### Fix

`src/renderer/terminal/drop-tracker.ts` separates *counting* from *ending*:
`enter`/`leave` count, and `end()` clears outright regardless of payload. `onDrop`
calls `end()` **first**, before any early return. Both components also listen on
`window` for `drop`, `dragend`, and a `dragleave` with a null `relatedTarget`
(which is exactly when a drag leaves the window) — because a drag that ends
outside the pane never sends the pane another event.

## Reproducing

The harness is a plain page driving the real xterm and FitAddon, which is how
this was measured without launching an unsigned build:

1. Copy `xterm.js`, `xterm.css` and `addon-fit.js` out of `node_modules/@xterm`.
2. Mount a terminal in a 920x420 `.term-mount`, fit it, then set the mount's
   height and then its width to `0px`, fitting after each change and logging
   what would be sent to the PTY.
3. Bundle `fit-guard.ts` with `esbuild --format=iife` to compare guarded and
   unguarded behaviour side by side.

## Tests

- `test/terminal-fit-guard.test.ts` — 9 tests, using the measured sizes above.
- `test/terminal-drop-tracker.test.ts` — 8 tests, including recovery from an
  unbalanced enter and a drop whose payload does not advertise files.
