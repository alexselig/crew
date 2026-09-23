import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
const measurement = readFileSync(
  new URL('../docs/performance/roster-render-measurement.md', import.meta.url),
  'utf8'
)

/**
 * A large roster is the worst case for renderer cost: every session card carries
 * an illustrated mascot (inline line art traced to hundreds of vector paths), and
 * the roster renders every card in the list — there is no windowing. Rosters of
 * 100+ sessions are real, so off-screen cards must not cost layout, paint, or
 * rasterization.
 *
 * These are contract tests: they pin the CSS that makes the browser skip that
 * work. They cannot measure frame cost, so pair them with the procedure in
 * docs/performance/roster-render-measurement.md against a signed build.
 */
describe('roster render cost contract', () => {
  it('skips rendering work for off-screen session cards', () => {
    const card = ruleFor('.card')
    expect(card).toContain('content-visibility: auto')
  })

  it('reserves an intrinsic size so skipped cards do not collapse the scrollbar', () => {
    const card = ruleFor('.card')
    // The `auto` keyword makes the browser remember each card's last real size,
    // so the placeholder estimate only applies before a card has ever rendered.
    expect(card).toMatch(/contain-intrinsic-size:\s*auto\s/)
  })

  it('opts a drag-over card out of containment so the drop line is not clipped', () => {
    // .card.is-drag-over::after draws the insertion line at top: -1px, i.e.
    // outside the padding box. content-visibility applies paint containment,
    // which would clip it, so the hovered card must opt out.
    const dragOver = ruleFor('.card.is-drag-over')
    expect(dragOver).toContain('content-visibility: visible')
  })

  it('promotes the animated mascot so a scale animation does not re-rasterize the line art', () => {
    // .character--run .character__art animates transform: scale(). Scaling
    // inline SVG re-tessellates and re-rasterizes every vector path unless the
    // element is promoted to its own compositor layer with a pinned raster
    // scale, which is what will-change: transform does.
    //
    // Measured, because this was once wrongly called unnecessary: removing the
    // hint takes the same cast from 8.4% to 32.3% GPU, i.e. 3.8x. Every other
    // variant kept the hint, so "the scale is free" was only ever true BECAUSE
    // of it. See docs/performance/mascot-animation-cost.md section 4.
    const art = ruleFor('.character--run .character__art')
    expect(art).toContain('will-change: transform')
  })

  it('paints the autopilot glow behind the mascot instead of filtering it', () => {
    // A drop-shadow over the line art is re-evaluated on every animation frame
    // -- roughly two thirds of foreground GPU cost. A background gradient
    // rasterizes once and survives the animation: 31.6% -> 8.2% GPU.
    const autopilot = ruleFor('.character--autopilot')
    expect(autopilot).toContain('radial-gradient')
    expect(css).not.toMatch(/\.character--autopilot[^{]*\{[^}]*drop-shadow/)
  })

  it('releases the promoted layers while the app is in the background', () => {
    // A paused animation still pins its compositor layer, so the background
    // idle rule drops the hint rather than paying GPU memory for a frame that
    // cannot change.
    const inactive = ruleFor('.crew-inactive *::after')
    expect(inactive).toContain('will-change: auto !important')
  })

  it('documents every signed-app acceptance check', () => {
    expect(measurement).toContain('signed')
    expect(measurement).toContain('Do not launch')
    expect(measurement).toContain('at least 40% lower')
    expect(measurement).toContain('at least 50% lower')
    expect(measurement).toContain('less than 50 MB')
    // top, not ps: ps %cpu is a lifetime average on macOS and would hide the change.
    expect(measurement).toContain('top')
    expect(measurement).toContain('drop indicator')
    expect(measurement).toContain('ps -axo pid=,comm=')
  })
})

/** The declaration block for an exact selector, so assertions cannot be
 *  satisfied by an unrelated rule elsewhere in the sheet. */
function ruleFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (!match) throw new Error(`no rule found for selector ${selector}`)
  return match[1]
}
