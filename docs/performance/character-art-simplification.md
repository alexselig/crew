# Simplifying the character art (PERF-04)

## What I predicted, and why it was wrong

The backlog card for this item estimated "~2x fewer coordinates, 40-70% node
reduction". That estimate was wrong, and it was wrong for a specific reason
worth recording so the mistake is not repeated.

`svgo`'s `convertPathData` does **coordinate rounding**, not **curve refitting**.
It makes the numbers in a `d` attribute shorter. It does not meaningfully reduce
how many drawing segments the rasteriser has to walk. Since raster cost tracks
*segments*, not *bytes*, most of the predicted rendering win never existed.

Measured across the whole cast:

| | Path data bytes | Drawing segments |
| --- | --- | --- |
| Predicted | ~-50% | ~-40-70% |
| **Actual** | **-12.9%** | **-5.5%** |

A real raster win would need Bezier refitting (RDP-style curve fitting), which
is a much larger and much riskier project. It is not what this item scoped.

## What this change actually delivers

- Renderer chunk **1,854.24 kB -> 1,777.93 kB** (-76.3 kB, **-4.1%**), measured
  by building both states through the same pipeline.
- Drawing segments -5.5%, which is real but small.
- No visible change, enforced by a pixel gate rather than by eye.

That is a modest, safe win. It is not the win the card promised.

## Per-character adaptive precision

A single global precision is the wrong shape for this problem, because the
aggregate is dominated by a handful of detailed characters:

| Global precision | Bytes | Worst pixel delta |
| --- | --- | --- |
| 0 | -63.3% | 3.8% of pixels, channel delta 112/255 - **visible** |
| 1 | -11.2% | 0.694% of pixels |
| 2 | -3.7% | 0.174% of pixels |

So `scripts/simplify-character-art.mjs` tries the coarsest precision first and
keeps, per character, the coarsest one that still passes the pixel gate. The
gate makes the call, not a human guess. Characters that pass at no precision are
left exactly as they were.

Outcome: 3 characters at precision 0, 47 at precision 1, 10 at precision 2, and
**4 left untouched**. That beats the best safe global setting (-12.9% vs -11.2%)
while being provably invisible per character rather than on average.

## The gate is the point

The script rasterises every character before and after at 24/48/64px with
`@resvg/resvg-js` and compares with `pixelmatch`, tolerating 0.05% of pixels.

This is not ceremony. The gate immediately caught a real bug in the first
version of this script: omitting SVGO's `moveGroupAttrsToElems` means
`applyTransforms` silently does nothing, leaving coordinates in pre-scale space.
Combined with rebuilding markup from extracted `d` attributes, that destroyed
the geometry of all 64 art blocks - and it was completely invisible in the diff.
The gate reported 10-27% of pixels differing and stopped it from being written.

Two rules follow, encoded in the script:

1. Use SVGO's actual output. Rebuilding markup means re-deciding which
   attributes survive, and getting that wrong is invisible in review.
2. `ART` is `Record<string, JSX.Element>`, so each entry must have exactly one
   root element. SVGO will unwrap a `<g>` it considers redundant, so the single
   `<g>` root has to be re-established when formatting.

## Running it

```bash
node scripts/simplify-character-art.mjs           # check only, writes nothing
node scripts/simplify-character-art.mjs --write   # apply, only if the gate passes
```

It is check-only by default and exits non-zero on a structural failure, so it is
safe to run in CI to prove the committed art still matches the gate.

## Should this have shipped?

Marginal, and worth being honest about. The bundle half of the win is largely
superseded by lazy-loading the art (PERF-05), which removes 100% of these bytes
from startup rather than shrinking them by 13%. The raster half is small.

It landed because it is cheap, provably invisible, and the gate script is
reusable tooling. It should not be taken as evidence that the original estimate
was sound.
