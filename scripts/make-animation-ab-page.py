#!/usr/bin/env python3
"""
Rank what foreground mascot animation actually costs, by variant.

The 0.7.1 measurement showed content-visibility cut GPU *memory* 39% but GPU
*CPU* only 12.5%, so the remaining cost is on-screen mascots, not skipped ones.
This isolates which property is responsible by rendering the SAME visible cast
five ways and letting an external sampler watch the browser's GPU process.

Crew's renderer is Chromium and every variant here is pure CSS, so a plain web
page is a faithful place to measure it -- no unsigned Electron build involved.

Usage:  python3 ab-animation-cost.py <outdir> [visible_count]
        variant is chosen by URL hash: #base #noshadow #noscale #opacityonly #static
"""
import re
import sys
from pathlib import Path

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/crew-anim-ab")
VISIBLE = int(sys.argv[2]) if len(sys.argv) > 2 else 12
CAST = sys.argv[3] if len(sys.argv) > 3 else "pilot"   # pilot|base

SRC = Path(__file__).resolve().parent.parent
art_src = (SRC / "src/renderer/character-art.tsx").read_text()


def extract(record: str) -> dict:
    start = art_src.index(f"const {record}")
    brace = art_src.index("{", start)
    depth, i = 0, brace
    while True:
        if art_src[i] == "{":
            depth += 1
        elif art_src[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    body = art_src[brace:i + 1]
    out = {}
    for m in re.finditer(r"^  (\w+): \(\s*(<g[\s\S]*?</g>)\s*\),?$", body, re.M):
        out[m.group(1)] = m.group(2)
    return out


ART = extract("ART_PILOT" if CAST == "pilot" else "ART")
if not ART:
    raise SystemExit("no character art extracted -- the record shape changed")
ids = sorted(ART)


def to_svg(group: str) -> str:
    """Strip JSX-isms so the markup is valid HTML/SVG."""
    g = re.sub(r"\{/\*[\s\S]*?\*/\}", "", group)
    g = re.sub(r"(\w+)=\{([^{}]*)\}", lambda m: f'{m.group(1)}="{m.group(2).strip()}"', g)
    for jsx, css in (
        ("strokeWidth", "stroke-width"), ("strokeLinecap", "stroke-linecap"),
        ("strokeLinejoin", "stroke-linejoin"), ("fillRule", "fill-rule"),
        ("clipRule", "clip-rule"), ("vectorEffect", "vector-effect"),
    ):
        g = g.replace(jsx, css)
    return g


PILOT_BADGE = (
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">'
    '<path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19'
    'v-5.5l8 2.5z" /></svg>'
)
SIZE = 48  # SessionCard.tsx renders the roster mascot at 48
COLORS = ["#f2f1ea", "#5bd6a0", "#7aa2f7", "#f7768e", "#e0af68", "#bb9af7", "#7dcfff"]

cards = []
for i in range(VISIBLE):
    cid = ids[i % len(ids)]
    color = COLORS[i % len(COLORS)]
    # Every visible card is running + autopilot: the worst realistic case, and
    # the only combination where the scale animation, the densest art and the
    # drop-shadow filter all land on the same element. Structure mirrors
    # Character.tsx / CharacterArt exactly, including the 512 pilot viewBox.
    vb = 'viewBox="0 0 512 512"' if CAST == 'pilot' else 'viewBox="0 0 1024 1024"'
    autop = ' character--autopilot' if CAST == 'pilot' else ''
    badge = (f'<span class="character__pilot" aria-label="autopilot" style="background:#5bd6a0">{PILOT_BADGE}</span>'
             if CAST == 'pilot' else '<span class="character__dot" style="background:#5bd6a0"></span>')
    cards.append(
        f'<div class="card">'
        f'<span class="character character--run{autop}" '
        f'style="font-size:{SIZE}px;width:{SIZE * 1.35}px;height:{SIZE * 1.35}px;color:{color}">'
        f'<svg class="character__art" {vb} width="{SIZE}" height="{SIZE}" '
        f'fill="currentColor" stroke="none" aria-hidden="true" focusable="false">{to_svg(ART[cid])}</svg>'
        f'{badge}'
        f'</span><span class="lbl">{cid}</span></div>'
    )

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "styles.css").write_text((SRC / "src/renderer/styles.css").read_text())

html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>mascot animation A/B</title>
<link rel="stylesheet" href="styles.css">
<style>
  :root {{ --accent: #5bd6a0; --radius: 0; }}
  body {{ background:#14161a; color:#f2f1ea; font:13px/1.4 -apple-system,sans-serif; margin:0; padding:16px; }}
  .grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:8px; max-width:900px; }}
  .card {{ display:flex; align-items:center; gap:6px; padding:10px; background:#1b1e24;
           content-visibility:visible; }}
  .lbl {{ font-size:11px; opacity:.7; }}
  .bar {{ position:fixed; top:0; right:0; background:#111; padding:8px 12px; border:1px solid #333; font-size:12px; }}
  .bar b {{ color:#5bd6a0; }}

  /* --- variants: each removes exactly one thing, so the delta is attributable --- */
  html.noshadow .character--autopilot .character__art,
  html.noshadow .character--autopilot .character__glyph {{ filter:none; }}

  html.noscale .character--run .character__art {{ animation-name: char-work-flat; }}
  @keyframes char-work-flat {{
    0%,100% {{ transform: translateY(0); opacity:.9; }}
    50%     {{ transform: translateY(-3px); opacity:1; }}
  }}

  html.opacityonly .character--run .character__art {{ animation-name: char-work-op; filter:none; }}
  @keyframes char-work-op {{ 0%,100% {{ opacity:.9; }} 50% {{ opacity:1; }} }}

  html.static .character--run .character__art {{ animation: none; filter:none; }}

  /* Keeps the glow EXACTLY as shipped, drops only the geometry change: tests
     whether it is the filter itself that costs, or recomputing it per frame
     because a transform keeps changing the geometry underneath it. */
  html.shadowop .character--run .character__art {{ animation-name: char-work-op2; }}
  @keyframes char-work-op2 {{ 0%,100% {{ opacity:.9; }} 50% {{ opacity:1; }} }}

  /* Keeps the motion, replaces the per-frame alpha-analysing drop-shadow with a
     static halo painted behind the art, which rasterises once. */
  /* Keeps the shipped glow EXACTLY, and spends the motion instead: the glow
     itself becomes the autopilot signal. */
  html.shadowstatic .character--run .character__art {{ animation: none; }}

  /* Halo tunings, tightest -> softest, for picking the closest visual match. */
  /* Restores the pre-fix drop-shadow so the shipped CSS can be measured
     against what it replaced, in a single run on one machine. */
  html.oldfilter .character--autopilot {{ background: none; }}
  html.oldfilter .character--autopilot .character__art,
  html.oldfilter .character--autopilot .character__glyph {{
    filter: drop-shadow(0 0 2.5px var(--accent));
  }}

  /* Does will-change: transform actually earn its keep? Every other variant
     keeps it, so 'the scale is free' could be true only because of it. */
  html.nowillchange .character--run .character__art {{ will-change: auto; }}
  html.nowillchange_noshadow .character--run .character__art {{ will-change: auto; }}
  html.nowillchange_noshadow .character--autopilot .character__art {{ filter:none; }}

  html.halo1 .character--autopilot .character__art {{ filter:none; }}
  html.halo1 .character--autopilot {{
    background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent) 42%, transparent) 0%, transparent 46%);
  }}
  html.halo2 .character--autopilot .character__art {{ filter:none; }}
  html.halo2 .character--autopilot {{
    background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent) 34%, transparent) 0%, transparent 54%);
  }}
  html.halo3 .character--autopilot .character__art {{ filter:none; }}
  html.halo3 .character--autopilot {{
    background: radial-gradient(circle at 50% 52%, color-mix(in srgb, var(--accent) 26%, transparent) 0%, transparent 64%);
  }}

  html.glowbg .character--autopilot .character__art {{ filter:none; }}
  /* Exact-look candidate: the filter input stops changing because the art no
     longer animates -- the PARENT carries the motion instead, so Chromium can
     cache the filtered art in a layer and merely transform it. */
  html.animparent .character--run .character__art {{ animation: none; }}
  html.animparent .character--run.character--autopilot {{
    animation: char-work 1.5s ease-in-out infinite;
    transform-origin: 50% 55%;
    will-change: transform;
  }}

  /* Same idea via an explicit layer hint on the filtered element. */
  html.filterlayer .character--autopilot .character__art {{ will-change: transform, filter; }}

  html.glowbg .character--autopilot {{
    background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--accent) 55%, transparent) 0%, transparent 62%);
  }}
</style></head>
<body>
<div class="bar">variant <b id="v">base</b> &middot; visible <b>{VISIBLE}</b> &middot; paths <b id="p">-</b></div>
<div class="grid">{''.join(cards)}</div>
<script>
const VARIANTS = ['base','noshadow','noscale','opacityonly','static','shadowop','glowbg','animparent','filterlayer','shadowstatic','halo1','halo2','halo3','nowillchange','nowillchange_noshadow','oldfilter']
function apply() {{
  const v = (location.hash || '#base').slice(1)
  document.documentElement.className = VARIANTS.includes(v) && v !== 'base' ? v : ''
  document.getElementById('v').textContent = VARIANTS.includes(v) ? v : 'base'
}}
addEventListener('hashchange', apply); apply()
document.getElementById('p').textContent = document.querySelectorAll('.grid path').length
</script>
</body></html>
"""
(OUT / "index.html").write_text(html)
print(f"wrote {OUT}/index.html  ({VISIBLE} visible cards)")
