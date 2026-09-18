#!/usr/bin/env python3
"""
Build a static review page for PR #14 (roster render cost).

The change is pure CSS and Crew's renderer is Chromium, so a plain page in a
normal browser is a faithful place to review it -- no unsigned Electron build
needed. This pulls the REAL styles.css and the REAL character line art out of
the repo so what you review is what ships.
"""
import json
import random
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/crew-roster-review")
CARDS = 115

art_src = (REPO / "src/renderer/character-art.tsx").read_text()


def extract(record: str) -> dict:
    """Pull `id: (<g ...>...</g>)` entries out of one JSX record."""
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
    body = art_src[brace : i + 1]
    out = {}
    for m in re.finditer(r"^  (\w+): \(\s*(<g[\s\S]*?</g>)\s*\),?$", body, re.M):
        out[m.group(1)] = m.group(2)
    return out


ART = extract("ART")
if not ART:
    raise SystemExit("no character art extracted -- the record shape changed")

# Mirrors STATE_META: the class drives which animation (if any) runs.
STATES = [
    ("run", "working", "#5bd6a0", 0.34),
    ("start", "starting", "#f2c14e", 0.10),
    ("idle", "waiting", "#f2f1ea", 0.28),
    ("sleep", "idle", "#8a8a8a", 0.18),
    ("gone", "exited", "#6b6b6b", 0.10),
]
COLORS = ["#f2f1ea", "#5bd6a0", "#7aa2f7", "#f7768e", "#e0af68", "#bb9af7", "#7dcfff"]
WORDS = ["crew", "atlas", "ghost", "deck", "forge", "bridge", "pilot", "relay", "vault",
         "quarry", "signal", "harbor", "lantern", "meridian", "cobalt", "ivory"]

rng = random.Random(7)
ids = sorted(ART)[:32]
cards = []
for n in range(CARDS):
    cid = ids[n % len(ids)]
    r, acc = rng.random(), 0.0
    for key, label, tint, weight in STATES:
        acc += weight
        if r <= acc:
            state, label, tint = key, label, tint
            break
    cards.append(
        {
            "i": n,
            "art": ART[cid],
            "state": state,
            "label": f"{rng.choice(WORDS)}-{rng.choice(WORDS)}",
            "meta": f"{rng.randint(1,59)}m ago · ${rng.randint(0,900)/100:.2f}",
            "status": label,
            "tint": tint,
            "color": rng.choice(COLORS),
        }
    )

rows = "\n".join(
    f"""<div class="card" data-session-id="s{c['i']}">
  <span class="character character--{c['state']}" style="font-size:48px;width:64.8px;height:64.8px;color:{c['color']}">
    <svg class="character__art" viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">{c['art']}</svg>
  </span>
  <div class="card__main">
    <span class="card__name">{c['label']}</span>
    <span class="card__meta">{c['meta']}</span>
  </div>
  <span class="card__status"><span class="rv-tag" style="color:{c['tint']}">{c['status']}</span></span>
  <div class="card__actions"></div>
</div>"""
    for c in cards
)

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "styles.css").write_text((REPO / "src/renderer/styles.css").read_text())

(OUT / "index.html").write_text(f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crew PR #14 — roster render cost review</title>
<link rel="stylesheet" href="./styles.css">
<style>
  body {{ margin: 0; background: var(--bg); color: var(--text);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
  .rv-bar {{ position: sticky; top: 0; z-index: 50; display: flex; gap: 14px;
             align-items: center; flex-wrap: wrap;
             padding: 10px 14px; background: var(--bg-elev);
             border-bottom: 1px solid var(--border); font-size: 13px; }}
  .rv-bar button {{ font: inherit; padding: 6px 12px; cursor: pointer;
                    color: var(--text); background: transparent;
                    border: 1px solid var(--border); border-radius: 6px; }}
  .rv-bar button.on {{ border-color: var(--accent, #2b4cf2);
                       background: rgba(43,76,242,.18); }}
  .rv-num {{ font-variant-numeric: tabular-nums; font-weight: 600; }}
  .rv-list {{ height: calc(100vh - 47px); overflow-y: auto; padding: 8px;
              max-width: 460px; border-right: 1px solid var(--border); }}
  .rv-tag {{ font-size: 11px; opacity: .8; }}
  .rv-note {{ opacity: .6; }}
  /* Reverting the PR, for A/B. Only these two rules differ. */
  html.baseline .card {{ content-visibility: visible !important;
                         contain-intrinsic-size: none !important; }}
  html.baseline .character--run .character__art {{ will-change: auto !important; }}
</style>
</head>
<body>
<div class="rv-bar">
  <button id="mode" class="on">Showing: PR #14</button>
  <button id="drag">Toggle drag-over on card 3</button>
  <button id="inactive">Simulate background</button>
  <span>skipped by browser: <span class="rv-num" id="skipped">–</span> / {CARDS}</span>
  <span>scroll fps: <span class="rv-num" id="fps">–</span></span>
  <span class="rv-note">{CARDS} cards · {len(ids)} mascots · real styles.css</span>
</div>
<div class="rv-list" id="list">
{rows}
</div>
<script>
const html = document.documentElement, list = document.getElementById('list')
const cards = [...document.querySelectorAll('.card')]

// The browser tells us directly which cards it is skipping. This is the
// optimisation being reviewed, reported by Chromium itself rather than inferred.
let skipped = 0
const out = document.getElementById('skipped')
if ('oncontentvisibilityautostatechange' in HTMLElement.prototype) {{
  for (const c of cards)
    c.addEventListener('contentvisibilityautostatechange', (e) => {{
      skipped += e.skipped ? 1 : -1
      out.textContent = skipped
    }})
  requestAnimationFrame(() => (out.textContent = skipped))
}} else out.textContent = 'unsupported'

document.getElementById('mode').onclick = (e) => {{
  const base = html.classList.toggle('baseline')
  e.target.textContent = base ? 'Showing: 0.7.0 baseline' : 'Showing: PR #14'
  e.target.classList.toggle('on', !base)
  skipped = 0
  out.textContent = base ? 'off (baseline)' : '0'
}}
document.getElementById('drag').onclick = (e) => {{
  const on = cards[3].classList.toggle('is-drag-over')
  cards[3].scrollIntoView({{ block: 'center' }})
  e.target.classList.toggle('on', on)
}}
document.getElementById('inactive').onclick = (e) => {{
  const on = document.body.classList.toggle('crew-inactive')
  e.target.classList.toggle('on', on)
  e.target.textContent = on ? 'Background (animations paused)' : 'Simulate background'
}}

// fps while scrolling -- the number that actually matters when you flick the list
let frames = 0, last = performance.now(), scrolling = 0
const fps = document.getElementById('fps')
list.addEventListener('scroll', () => {{
  scrolling = performance.now()
}}, {{ passive: true }})
;(function tick(now) {{
  frames++
  if (now - last >= 500) {{
    fps.textContent = now - scrolling < 600 ? Math.round((frames * 1000) / (now - last)) : '–'
    frames = 0
    last = now
  }}
  requestAnimationFrame(tick)
}})(performance.now())
</script>
</body>
</html>
""")

print(f"characters extracted : {len(ART)}")
print(f"cards rendered       : {CARDS} using {len(ids)} mascots")
print(f"wrote                : {OUT/'index.html'}")
