# What foreground mascot animation actually costs

> The browser A/B below is a plain web page in Microsoft Edge, not an Electron
> build, so the signed-build rule does not apply to it. The 0.7.1 process
> sampling *is* against the installed signed app.

This answers the question [gpu-cost-measurement.md](./gpu-cost-measurement.md)
left open — how much of the 28.1% PR #14 removed — and then finds where the
remainder actually goes. Both answers were surprises, and both contradict
something previously written down.

## 1. What `content-visibility` actually bought

Same procedure and roster size as the 0.7.0 baseline: installed signed build,
`top -l 8 -s 2`, first sample per PID discarded, 116 sessions.

| | 0.7.0 (no PR #14) | 0.7.1 (with PR #14) | change |
| --- | --- | --- | --- |
| GPU helper CPU | 28.1% | **24.6%** | **-12.5%** |
| Renderer CPU | 16.3% | **13.0%** | **-20.2%** |
| GPU helper memory | 573 MB | **347 MB** | **-39.4%** |
| Renderer memory | 155 MB | **104 MB** | **-32.9%** |

The prediction was: "the off-screen share of that 28% should simply disappear."
**It did not.** `content-visibility` delivered a large *memory* win and only a
marginal *CPU* win.

The reason is straightforward in hindsight: skipping off-screen cards removes
the compositor layers they would have occupied — which is memory — but the CPU
was never being spent on them. It is spent on the mascots you can actually see.

That reframes the whole problem. The remaining cost is **per visible mascot**,
so the useful question is what a single on-screen mascot costs, and why.

## 2. Which property costs the money

`scripts/make-animation-ab-page.py` renders the real `ART_PILOT` line art with
the real `styles.css`, in the DOM shape `Character.tsx` produces (48px, the
512 pilot viewBox, `fill="currentColor"`), and varies exactly one property per
variant. `scripts/measure-animation-ab.sh` gives each variant its own isolated
Edge instance so the GPU helper PID is unambiguous, and samples it.

Twelve visible cards, all `--run --autopilot` — the worst realistic case, and
the only combination where the densest art, the scale animation and the
drop-shadow all land on one element.

| Variant | What changes | GPU median | vs base |
| --- | --- | --- | --- |
| `base` | as shipped | 31.6% | — |
| `noscale` | drop the scale, keep translate + filter | 31.2% | **+8.9%** |
| `shadowop` | keep filter, animate opacity only | 30.9% | **+1.0%** |
| `filterlayer` | keep everything, add `will-change: filter` | 30.1% | **+8.1%** |
| `animparent` | filter static, move animation to the parent | 47.0% | **+68.8%** |
| `noshadow` | remove the drop-shadow only | 8.2% | **-70.6%** |
| `glowbg` | drop-shadow -> painted halo, motion kept | 8.6% | **-72.8%** |
| `halo1` | tuned halo, closest visual match | 8.2% | **-74.1%** |
| `shadowstatic` | keep the glow, drop the motion | 0.7% | **-97.8%** |
| `static` | no animation at all | 0.1% | -99.6% |

A non-autopilot cast — base art, no filter, same `char-work` motion — measures
**7.9%**. That is the floor for twelve animating mascots, and `noshadow` (8.2%)
and `glowbg` (8.6%) both land on it.

**The drop-shadow is roughly two thirds of foreground GPU cost**, and an
autopilot mascot costs about **3.7x** a plain one.

## 3. Every way of keeping the filter failed

This is the part worth remembering. Four different attempts to keep
`drop-shadow` and make it cheap by changing *the animation* all failed:

- Removing the scale did nothing (`noscale`, +8.9%).
- Removing the transform entirely and animating only opacity did nothing
  (`shadowop`, +1.0%). This is decisive: the filter is re-evaluated per frame
  even when the geometry never changes.
- Hinting a cached layer did nothing (`filterlayer`, +8.1%).
- Moving the motion to the parent so the filter input is static made it
  **much worse** (`animparent`, +68.8%) — the filter then applies to a larger
  animating subtree.

So this is not a "compose it better" problem. A `drop-shadow` over complex
vector art has to re-analyse the source alpha, and anything that invalidates
the frame pays for it again. The filter has to go, or be replaced by something
that rasterises once.

## 4. One thing previously written down is wrong — and one nearly was

**`will-change: transform` is load-bearing. Do not remove it.**

An earlier draft of this document claimed the opposite, reasoning that since
removing the scale (`noscale`) changed nothing, the hint was defending against
a cost that could not be measured. That reasoning was broken: *every* variant
above keeps the hint, so all `noscale` proved is that the scale is cheap **given
the pinned layer**. Measuring it directly says the opposite:

| Variant | GPU median |
| --- | --- |
| `noshadow` — no filter, hint present | **8.4%** |
| `nowillchange_noshadow` — no filter, hint removed | **32.3%** |
| `nowillchange` — filter present, hint removed | **42.0%** |

Removing the hint costs **3.8x**. Its comment in `styles.css` is exactly right:
without it, scaling the inline SVG re-rasterizes the line art every frame. The
claim was retracted before it could be acted on, which is the only reason it is
written up here rather than silently deleted — acting on it would have tripled
the cost it was trying to reduce.

**PERF-04 was still re-ranked on a false premise, but a subtler one.** It was
promoted to "the most valuable remaining item" because mascots "re-rasterize at
animation frame rate, and that cost is directly proportional to path
complexity". With `will-change` present, the art is rasterized once into a
pinned layer and the animation only composites it, so per-frame cost does *not*
track path count. Cutting node count cuts the one-time raster and the layer
memory — real, but not the per-frame win that justified the ranking. That
matches what PERF-04 delivered: a bundle-size win and no measurable frame-cost
win.

The two mechanisms are independent: the layer hint neutralizes the scale, and
nothing neutralizes the filter.

## 5. What to do, and what was rejected

**Shipped here:** replace `filter: drop-shadow(0 0 2.5px var(--accent))` on
`.character--autopilot` with a halo painted behind the mascot. It rasterizes
once and survives the animation, measuring **8.2%** against a **31.6%** base —
about **-74%** — with the motion fully intact.

The halo is tuned to the shipped glow rather than eyeballed. Rendering both and
differencing the pixels picked the tightest of three candidates:

| Tuning | mean pixel difference | pixels differing by >8/255 |
| --- | --- | --- |
| **`halo1` (shipped)** | **0.94** | **4.1%** |
| `halo2` | 3.78 | 8.1% |
| `halo3` | 4.23 | 10.0% |

It is not pixel-identical: the filter hugs the stroke outline, the halo is a
soft disc behind it. At a 2.5px spread on a 48px mascot that reads as a very
slightly softer glow, and it is the only visual change.

### How the shipped CSS was verified

The number above was measured on a harness variant, not on the stylesheet. To
close that gap, `styles.css` was patched first and the harness regenerated
*from the patched file*, so its `base` variant is the real shipped rule. Diffing
that render against the pre-fix glow reproduces the `halo1` row exactly — mean
0.94 vs 0.90, 4.1% vs 4.1% of pixels — so what shipped is the thing that was
measured, not a retyped approximation of it.

`scripts/make-animation-ab-page.py` now also carries an `oldfilter` variant that
restores the drop-shadow on top of current CSS, so the before/after can be
re-run on one machine in one session.

**Not captured:** a fresh guarded before/after on the shipped CSS. MSTeams held
focus through every retry, and the guard correctly refused to emit numbers from
an occluded window rather than reporting the spectacular fake wins described in
section 3. The claim therefore rests on the four earlier guarded base runs plus
the pixel-diff equivalence above, not on a fifth measurement.

**Rejected: `shadowstatic`, which keeps the glow exactly and drops the motion
instead.** It is far cheaper (0.7%) and preserves the signature glow pixel for
pixel, so it is tempting. It was rejected because it collapses a distinction the
UI depends on: `char-work` is what separates an autopilot session that is
*working* from one that is merely *on autopilot and idle*. Both would become a
still, glowing mascot. That trades an information signal for an aesthetic one,
which is a worse deal than softening a glow by 4% of its pixels.

## Reproducing

```bash
python3 scripts/make-animation-ab-page.py /tmp/crew-anim-ab 12 pilot
cd /tmp/crew-anim-ab && python3 -m http.server 8934 --bind 127.0.0.1 &
URL_BASE=http://127.0.0.1:8934/ VARIANTS="base noshadow glowbg static" \
  bash scripts/measure-animation-ab.sh
```

Pass `base` instead of `pilot` as the third argument for the non-autopilot cast.

**The occlusion guard is not optional.** An occluded browser window stops
compositing, so anything stealing focus mid-run — a Teams popup will do it —
reads as a spectacular fake result. Two variants in this investigation first
measured -99.8% and -69.9% that way; re-measured with the guard they were
**+8.1%** and **+68.8%**. The script verifies Edge is frontmost immediately
before and after each run and retries when it is not, and the summary flags any
variant whose mean and median diverge.
