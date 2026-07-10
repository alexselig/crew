// Layout glyphs for the view/density toggle: filled rounded-rect "panes" whose
// shape mirrors the current window layout (1 single pane, or 2/4/6-up grids), so
// the button doubles as a live indicator of the current layout — not just a
// generic grid icon. Cells use currentColor, matching the surrounding icon-btn
// text color and its hover/active states. Proportions follow the design handoff
// (24×24 viewBox, per-state gap/radius tuned for legibility at small sizes).

export type LayoutState = 1 | 2 | 4 | 6

interface Cell {
  x: number
  y: number
  w: number
  h: number
  rx: number
}

// Precomputed cell rects per state (24×24 space). State 1 is a 3×3 lattice
// (single active pane, per the handoff); 2 = two columns, 4 = 2×2, 6 = 2×3.
const CELLS: Record<LayoutState, Cell[]> = {
  1: (() => {
    const s = 6.67
    const step = 8.67
    const out: Cell[] = []
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) out.push({ x: c * step, y: r * step, w: s, h: s, rx: 1.4 })
    return out
  })(),
  2: [
    { x: 0, y: 0, w: 10.75, h: 24, rx: 1.8 },
    { x: 13.25, y: 0, w: 10.75, h: 24, rx: 1.8 }
  ],
  4: [
    { x: 0, y: 0, w: 10.75, h: 10.75, rx: 1.8 },
    { x: 13.25, y: 0, w: 10.75, h: 10.75, rx: 1.8 },
    { x: 0, y: 13.25, w: 10.75, h: 10.75, rx: 1.8 },
    { x: 13.25, y: 13.25, w: 10.75, h: 10.75, rx: 1.8 }
  ],
  6: [
    { x: 0, y: 0, w: 10.75, h: 6.33, rx: 1.8 },
    { x: 13.25, y: 0, w: 10.75, h: 6.33, rx: 1.8 },
    { x: 0, y: 8.83, w: 10.75, h: 6.33, rx: 1.8 },
    { x: 13.25, y: 8.83, w: 10.75, h: 6.33, rx: 1.8 },
    { x: 0, y: 17.67, w: 10.75, h: 6.33, rx: 1.8 },
    { x: 13.25, y: 17.67, w: 10.75, h: 6.33, rx: 1.8 }
  ]
}

/** Filled-pane glyph for a given layout state (1/2/4/6). */
export function LayoutGlyph({ state, size = 14 }: { state: LayoutState; size?: number }): JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      {CELLS[state].map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} rx={c.rx} />
      ))}
    </svg>
  )
}
