// Simplify the traced (potrace) character art in src/renderer/character-art.tsx.
//
// WHY: the art is bitmap-traced, and tracer output encodes pixel-level wobble
// that is invisible at the sizes Crew actually draws it (24-64px). Measured in
// the built renderer bundle, raw SVG path data was 555,222 bytes across 578
// path strings — 29.9% of the whole 1.85 MB chunk.
//
// The mascots animate continuously while Crew is frontmost (see
// docs/performance/gpu-cost-measurement.md: the GPU helper goes 28.1% -> 0.0%
// CPU when motion pauses), so every path on screen is re-rasterized at
// animation frame rate. Cheaper paths are cheaper frames.
//
// HOW IT IS SAFE: nothing here is taken on trust. Every character is
// rasterized before and after at each size Crew renders it, and compared
// pixel-by-pixel. Anything that moves a pixel more than THRESHOLD fails the
// run and nothing is written. The gate is the point of this script; the
// optimisation is the easy half.
//
//   node scripts/simplify-character-art.mjs          # check only, writes nothing
//   node scripts/simplify-character-art.mjs --write  # apply, only if the gate passes

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { optimize } from 'svgo'
import { Resvg } from '@resvg/resvg-js'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(REPO, 'src/renderer/character-art.tsx')

/** Sizes Crew actually draws the art at. The roster/picker use the small end;
 *  the largest is the header/hero treatment. Verifying at all three stops us
 *  tuning for a thumbnail and regressing a large render. */
const SIZES = [24, 48, 64]

/** Fraction of differing pixels tolerated per character per size. Kept very
 *  tight deliberately: the whole argument for this change is that it is
 *  invisible, so anything visible is a failure, not a tuning opportunity. */
const THRESHOLD = 0.05

/** Precisions to attempt, coarsest first. Each character keeps the coarsest
 *  rounding that still passes the pixel gate, and characters where none pass
 *  are left untouched.
 *
 *  A single global precision is the wrong shape for this problem. Measured
 *  across the whole cast, precision 0 is 63.3% smaller but moves 3.8% of
 *  pixels by up to 112/255 — visible. Precision 1 is safe but only 11.2%
 *  smaller. Those aggregates are dominated by a handful of characters with
 *  fine detail; most of the cast tolerates far coarser rounding than the
 *  worst member does. Deciding per character captures that, and the gate —
 *  not a human guess — makes the call. */
const FLOAT_PRECISIONS = [0, 1, 2]

// `moveGroupAttrsToElems` must run BEFORE convertPathData, otherwise
// `applyTransforms` has nothing to apply: the transform stays on the <g> and
// the coordinates are left in the pre-scale space. An earlier version of this
// script omitted it and then dropped the <g transform> when rebuilding, which
// silently destroyed the geometry of all 64 characters. The pixel gate caught
// it (10-27% of pixels differing), which is the entire reason the gate runs
// before anything is written.
const svgoConfig = (floatPrecision) => ({
  multipass: true,
  plugins: [
    'moveGroupAttrsToElems',
    { name: 'convertPathData', params: { floatPrecision, applyTransforms: true, straightCurves: true } }
  ]
})

/** Elements and attributes we are willing to emit back into JSX. Anything else
 *  means SVGO produced a shape this script was not designed to round-trip, and
 *  we stop rather than write something unreviewed into the component. */
const ALLOWED_TAGS = new Set(['g', 'path'])
const ALLOWED_ATTRS = new Set(['d', 'transform'])

/** Count real drawing segments, not command letters. A single `c` can carry
 *  many segments, so counting letters (as an earlier draft of this script did)
 *  reports nonsense — it can even show a count going *up* after a successful
 *  optimisation. Segment count is what raster cost actually tracks. */
const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
export function countSegments(svg) {
  let n = 0
  for (const m of svg.matchAll(/ d="([^"]+)"/g)) {
    const toks = m[1].match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e-?\d+)?/g) || []
    let cmd = null
    for (let i = 0; i < toks.length; ) {
      if (/[A-Za-z]/.test(toks[i])) {
        cmd = toks[i].toLowerCase()
        i++
        if (cmd === 'z') { n++; continue }
      }
      i += ARGS[cmd] ?? 2
      n++
    }
  }
  return n
}

const wrap = (inner, vb) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}" fill="currentColor" color="#000">${inner}</svg>`

function raster(svg, size) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'white' }).render().asPng()
  return PNG.sync.read(png)
}

/** Percentage of pixels that differ between two renders of the same art. */
function pixelDelta(beforeSvg, afterSvg, size) {
  const a = raster(beforeSvg, size)
  const b = raster(afterSvg, size)
  if (a.width !== b.width || a.height !== b.height) return 100
  const differing = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
  return (differing / (a.width * a.height)) * 100
}

/** Render SVGO's output as JSX indented to match the surrounding file.
 *
 *  ART is typed `Record<string, JSX.Element>`, so each entry must be exactly
 *  ONE root element. SVGO is free to unwrap a group it considers redundant,
 *  which would leave sibling <path> elements and produce a file that does not
 *  compile — so always re-establish a single <g> root. */
function formatJsx(inner) {
  const paths = [...inner.matchAll(/<path\b[^>]*\/?>/g)].map((m) => m[0])
  const rootG = inner.match(/^<g\b([^>]*)>([\s\S]*)<\/g>$/)
  const attrs = rootG ? rootG[1].trimEnd() : ''
  const body = paths
    .map((p) => `      ${p.replace(/\s*\/?>$/, ' />')}`)
    .join('\n')
  return `<g${attrs}>\n${body}\n    </g>`
}

/** Locate every `<g transform="...">...</g>` art block in the source. */function findBlocks(src) {
  const blocks = []
  const re = /<g transform="translate\(0,(\d+)\) scale\(0\.1,-0\.1\)">([\s\S]*?)<\/g>/g
  let m
  while ((m = re.exec(src))) {
    blocks.push({ start: m.index, end: m.index + m[0].length, raw: m[0], viewBox: Number(m[1]) })
  }
  return blocks
}

function main() {
  const write = process.argv.includes('--write')
  const src = readFileSync(TARGET, 'utf8')
  const blocks = findBlocks(src)
  if (!blocks.length) {
    console.error('No art blocks found — has the shape of character-art.tsx changed?')
    process.exit(1)
  }

  let beforeBytes = 0
  let afterBytes = 0
  let beforeSegs = 0
  let afterSegs = 0
  const failures = []
  const replacements = []
  const skipped = []
  const chosen = new Map(FLOAT_PRECISIONS.map((p) => [p, 0]))

  for (const block of blocks) {
    const beforeSvg = wrap(block.raw, block.viewBox)
    let accepted

    // Coarsest first: the first precision that survives the gate wins. A
    // character that survives none is left exactly as it was — shrinking the
    // bundle is never worth changing what the user sees.
    for (const precision of FLOAT_PRECISIONS) {
      const optimized = optimize(beforeSvg, svgoConfig(precision)).data

      // Use exactly what SVGO produced rather than rebuilding the markup from
      // extracted `d` attributes. Rebuilding means re-deciding which attributes
      // survive, and getting that wrong is invisible in the diff but catastrophic
      // on screen.
      const innerMatch = optimized.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
      if (!innerMatch) { failures.push({ block, reason: 'optimiser returned no <svg> wrapper' }); break }
      const inner = innerMatch[1].trim()

      // A structural surprise means this script is wrong about the art, not
      // that this precision is too coarse — so it aborts rather than retrying.
      const badTag = [...inner.matchAll(/<\s*([a-zA-Z]+)/g)].map((m) => m[1]).find((t) => !ALLOWED_TAGS.has(t))
      if (badTag) { failures.push({ block, reason: `optimiser emitted unsupported element <${badTag}>` }); break }
      const badAttr = [...inner.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]).find((a) => !ALLOWED_ATTRS.has(a))
      if (badAttr) { failures.push({ block, reason: `optimiser emitted unsupported attribute "${badAttr}"` }); break }

      const afterSvg = wrap(inner, block.viewBox)
      const deltas = SIZES.map((s) => ({ size: s, delta: pixelDelta(beforeSvg, afterSvg, s) }))
      const worst = deltas.reduce((a, b) => (b.delta > a.delta ? b : a))
      if (worst.delta > THRESHOLD) continue

      accepted = { precision, inner, afterSvg, worst }
      break
    }

    if (!accepted) {
      skipped.push(block)
      const unchanged = (block.raw.match(/d="[^"]*"/g) || []).join('').length
      beforeBytes += unchanged
      afterBytes += unchanged
      const segs = countSegments(beforeSvg)
      beforeSegs += segs
      afterSegs += segs
      continue
    }

    chosen.set(accepted.precision, chosen.get(accepted.precision) + 1)
    beforeBytes += (block.raw.match(/d="[^"]*"/g) || []).join('').length
    afterBytes += (accepted.inner.match(/d="[^"]*"/g) || []).join('').length
    beforeSegs += countSegments(beforeSvg)
    afterSegs += countSegments(accepted.afterSvg)
    replacements.push({ start: block.start, end: block.end, text: formatJsx(accepted.inner) })
  }

  const pct = (before, after) => `${(100 - (after / before) * 100).toFixed(1)}%`
  console.log(`characters checked : ${blocks.length}`)
  console.log(`path data bytes    : ${beforeBytes} -> ${afterBytes}  (${pct(beforeBytes, afterBytes)} smaller)`)
  console.log(`drawing segments   : ${beforeSegs} -> ${afterSegs}  (${pct(beforeSegs, afterSegs)} fewer)`)
  console.log(`pixel gate         : ${SIZES.join('/')}px, tolerance ${THRESHOLD}% of pixels`)
  for (const p of FLOAT_PRECISIONS) console.log(`  precision ${p}        : ${chosen.get(p)} character(s)`)
  console.log(`  left unchanged     : ${skipped.length} character(s)`)

  if (failures.length) {
    console.error(`\nGATE FAILED for ${failures.length} character(s); nothing written:`)
    for (const f of failures) console.error(`  - ${f.reason}`)
    process.exit(1)
  }
  console.log('\nGATE PASSED — every rewritten character is pixel-identical within tolerance at every size.')

  if (!write) {
    console.log('Check-only run. Re-run with --write to apply.')
    return
  }

  let out = src
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end)
  }
  writeFileSync(TARGET, out)
  console.log(`\nWrote ${TARGET}`)
}

main()
