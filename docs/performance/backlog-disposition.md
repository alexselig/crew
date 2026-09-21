# Disposition of the approved performance backlog

Eight items (PERF-01..08) were approved for implementation. **Four shipped.
Four were closed with evidence instead of being built**, because measuring them
showed they would not deliver what their cards claimed.

That ratio is the point, not an embarrassment. Three of the four estimates that
failed were mine, and each failed for a reason that was cheap to measure and
expensive to guess.

| Item | Outcome | Evidence |
| --- | --- | --- |
| PERF-01 Measure GPU cost | **Shipped** (docs) | Foreground/background A/B on the signed build |
| PERF-02 `content-visibility` on the picker | **Closed - no-op** | Picker unmounts when closed |
| PERF-03 Store write path | **Shipped** | 24.17ms -> 0.69ms routine flush |
| PERF-04 Simplify character art | **Shipped, reduced** | -4.1% chunk, not the predicted ~2x |
| PERF-05 Lazy-load character art | **Closed - too small** | Whole module parses+evals in 3.64ms |
| PERF-06 Retire idle terminal pool | **Shipped** | Up to 24 live xterms -> 12 |
| PERF-07 Roster IPC deltas | **Closed - contradicted** | Renderer sits at 0.2% while main still emits |
| PERF-08 Code-split the art | **Closed - depends on 05** | Falls with PERF-05 |

## PERF-01 re-ranked everything else

It was sequenced first precisely because its answer could invalidate the rest,
and it did. Backgrounding Crew (which already pauses motion) moved the GPU
process from **28.1% -> 0.0%** CPU and the renderer from **16.3% -> 0.2%**,
while GPU memory fell **573 -> 445 MB**.

Two conclusions follow:

- Essentially all steady-state cost is **foreground mascot animation** - paint
  and compositing, not JS, not IPC, not raster churn.
- The unexplained ~130 MB memory swing is simply compositor layers being
  allocated and released. There is nothing pathological in the GPU process.

## Why PERF-07 was closed despite being approved

PERF-07 proposed sending roster deltas instead of full snapshots, on the
measured basis that 115 sessions serialize to 43.7 KB emitted up to 4x/sec
(~175 KB/s).

PERF-01 contradicts it. The renderer sits at **0.2%** while the main process
keeps emitting those snapshots at full rate. The IPC is not what costs 16.3%
when foregrounded - **painting is**. Shipping delta encoding would add real
complexity (sequence numbers, resync on drop, divergence bugs) to remove a cost
that measurement says is close to zero.

The 175 KB/s number is real. It is just not a *cost* anywhere that matters yet.
Worth revisiting if the roster grows by an order of magnitude.

## Why PERF-05 and PERF-08 were closed

The theory was good: `ART` is an object literal, so all 64 art groups (547
paths) are constructed via `React.createElement` at **module-eval time**, on
every start, no matter how few characters are visible.

So it was measured rather than assumed. Transforming the real module and timing
parse + eval in isolation, with `hasCharacterArt('fox') === true` afterwards to
prove the data was genuinely retained and not tree-shaken away:

```
module bytes       : 487,084
import (parse+eval): 3.64 ms
```

**~3.6 ms.** Against that, lazy-loading costs an async boundary, a suspense
fallback, a separate static key list to keep `hasCharacterArt` synchronous (it
is used for *layout* decisions in `HeaderTakeoff`, `Character`, and
`ProjectTracker`), and a real risk of mascots popping in on the roster - Crew's
signature visual.

Trading a visible layout shift for 3.6 ms is a bad trade. PERF-08 was scoped as
the code-splitting half of the same idea and falls with it.

## Why PERF-02 was closed

`.char-picker__panel` has no constrained height and no `overflow`, so
`content-visibility` would have had nothing to skip. More decisively, the picker
is **unmounted when closed** (`CharacterPicker.tsx:91-93`), its cells are static
(no `char-run`/`char-work`/`char-blink`), and it renders ~152 paths. There was
no cost to remove.

This also corrected an error in the backlog itself: the app has **32**
characters, not 64. The 64 figure double-counted `ART` and `ART_PILOT`, which
are two variants of the same cast.

## The estimate that was wrong, and why

PERF-04's card predicted "~2x fewer coordinates, 40-70% node reduction". Actual:
**-12.9% bytes, -5.5% segments**. The cause is specific and worth remembering:
`svgo` does **coordinate rounding, not curve refitting**. It shortens the
numbers in a `d` attribute without meaningfully reducing the segments a
rasteriser walks - and raster cost tracks segments, not bytes.

It shipped anyway at -76.3 kB (-4.1% of the renderer chunk) because it is cheap
and provably invisible, but it is not the win that was sold.

## What actually remains

The measured problem is **foreground animation cost**: three infinite CSS
animations (`char-run`, `char-work`, `char-blink` in `styles.css`) plus a
`drop-shadow` filter on autopilot characters, multiplied by however many
characters are on screen.

The honest next step is to reduce *how much is animated at once* or how
expensive each animated element is to rasterise - not to keep shaving JS.

One question stays open and cannot be answered on this machine: how much of the
28.1% the `content-visibility` fix already removed. Confirming it needs a signed
build containing that change, and cutting one was explicitly out of scope.
