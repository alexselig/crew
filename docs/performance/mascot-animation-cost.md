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

## 4. Two things previously written down are wrong

**`will-change: transform` on `.character--run .character__art` is not earning
its keep.** Its comment says that without it "a roster of running sessions
re-rasterizes its whole cast at animation frame rate". Removing the scale
altogether (`noscale`) changes nothing, so the scale is not what costs — which
means the hint is defending against a cost that measurement cannot find. It is
also not free: `will-change` forces a permanent compositor layer per mascot,
which is part of the memory this document is otherwise trying to reduce.

**PERF-04's premise was false.** Path simplification was re-ranked "the most
valuable remaining item" on the reasoning that scaling re-rasterizes every path
each frame, so cutting node count cuts per-frame cost. Measurement says the
scale is free and the filter is not. That is consistent with what PERF-04
actually delivered: a bundle-size win and no measurable frame-cost win. The
honest conclusion is that it was correctly *shipped* and incorrectly *ranked*.

## 5. What to do next

Replace `filter: drop-shadow(0 0 2.5px var(--accent))` on
`.character--autopilot` with a halo painted behind the art, which rasterises
once and survives the animation. Measured at **-72.8%** GPU with the motion
fully intact.

This is a visual change, not a free one: the shipped filter hugs the stroke
outline, while a painted halo reads as a softer radial bloom. It needs a design
decision before it ships, which is why this document stops at the measurement.

If the exact glow must be preserved, the remaining lever is **how many
filtered mascots are on screen at once** — because per-element, nothing makes
`drop-shadow` cheap.

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
