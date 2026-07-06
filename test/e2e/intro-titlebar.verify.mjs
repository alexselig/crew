// Ad-hoc visual + numeric verification for:
//  1) the click-to-start title launch sequence (zoom-in-10%-then-back pulse), and
//  2) task 12 — the session-header title matching the nav card title in
//     font size/weight and spacing-from-icon.
// The boot intro is gated off under automation (navigator.webdriver), so the
// overlay is exercised here via the nav-logo replay path.
// Screenshots -> $SHOTS (default: /tmp/crew-intro).

import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHOTS = process.env.SHOTS || '/tmp/crew-intro'
mkdirSync(SHOTS, { recursive: true })
const ROOT = resolve(process.cwd())
const DATA_DIR = '/tmp/crew-intro-data'
rmSync(DATA_DIR, { recursive: true, force: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PALETTE = [
  '#ff5a5a', '#ff7a3c', '#ff9f2e', '#ffd23c', '#c6e04a', '#7ed957', '#45c98a', '#34d0c3',
  '#37c0e6', '#4aa8ff', '#8a6dff', '#b57cff', '#d86fe0', '#ff6fb5', '#ff6f8f', '#9aa4ad'
]
const hexToRgb = (h) => {
  const n = parseInt(h.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
const paletteRgb = new Set(PALETTE.map(hexToRgb))
let n = 0
let fail = 0
const shot = async (page, name) => {
  const f = join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: f })
  console.log('  📸', f)
}
const eq = (a, b, msg) => {
  if (a === b) console.log('  ✓', msg, `(${a})`)
  else { fail++; console.log('  ✗', msg, `(${a} !== ${b})`) }
}
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  ✓', msg, extra)
  else { fail++; console.log('  ✗', msg, extra) }
}

async function main() {
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), `--user-data-dir=${DATA_DIR}`],
    cwd: ROOT
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.app', { timeout: 10000 })

  // Boot intro is skipped under automation → app is directly interactive.
  ok((await page.locator('.intro').count()) === 0, 'boot intro skipped under automation')

  // --- Create a session so the title bar shows a session title ---
  await page.locator('.roster__header button:has-text("New Session")').click()
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.locator('.modal select.field__input').selectOption('shell')
  await page.locator('.field:has(.field__label:has-text("Working directory")) input').fill(ROOT)
  await page.locator('.field:has(.field__label:has-text("Label")) input').fill('Fix login bug')
  await page.locator('.modal button:has-text("Launch")').click()
  await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 })
  await page.waitForSelector('.card', { timeout: 8000 })
  await page.waitForSelector('.session-header__label', { timeout: 8000 })
  await sleep(300)
  await shot(page, 'session-header-and-card')

  // --- Numeric comparison: header title vs nav card title (task 12) ---
  const metrics = await page.evaluate(() => {
    const cs = (el, p) => getComputedStyle(el)[p]
    const textLeft = (el) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      return r.getBoundingClientRect().left
    }
    const cardName = document.querySelector('.card__name')
    const cardArt = document.querySelector('.card .character__art')
    const label = document.querySelector('.session-header__label')
    const headArt = document.querySelector('.session-header .character__art')
    return {
      cardName: { size: cs(cardName, 'fontSize'), weight: cs(cardName, 'fontWeight') },
      headLabel: { size: cs(label, 'fontSize'), weight: cs(label, 'fontWeight') },
      cardGap: +(textLeft(cardName) - cardArt.getBoundingClientRect().right).toFixed(1),
      headGap: +(textLeft(label) - headArt.getBoundingClientRect().right).toFixed(1)
    }
  })
  console.log('  metrics:', JSON.stringify(metrics))
  eq(metrics.headLabel.size, metrics.cardName.size, 'title font-size matches card')
  eq(metrics.headLabel.weight, metrics.cardName.weight, 'title font-weight matches card')
  ok(Math.abs(metrics.headGap - metrics.cardGap) <= 2, 'icon→title spacing matches card',
    `(Δ=${Math.abs(metrics.headGap - metrics.cardGap).toFixed(1)}px)`)

  // --- Show the intro via the nav "Crew" logo → click-to-start poster ---
  await page.locator('button.roster__wordmark').click()
  await page.waitForSelector('.intro.intro--idle', { timeout: 3000 })
  await sleep(150)
  await shot(page, 'intro-poster')

  const poster = await page.evaluate(() => {
    const s = document.querySelector('.intro__start')
    const b = s.getBoundingClientRect()
    const iconEls = [...document.querySelectorAll('.intro__icon')]
    let onScreen = 0
    for (const el of iconEls) {
      const r = el.getBoundingClientRect()
      if (r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight)
        onScreen++
    }
    return {
      text: s.textContent.trim(),
      icons: iconEls.length,
      onScreen,
      offScreen: iconEls.length - onScreen,
      centeredX: Math.abs((b.left + b.right) / 2 - window.innerWidth / 2),
      fromBottom: Math.round(window.innerHeight - b.bottom)
    }
  })
  eq(poster.text, 'click to start', 'poster shows "click to start"')
  ok(poster.icons >= 90 && poster.icons <= 150, 'field has ~5x the icons', `(${poster.icons} total)`)
  ok(poster.offScreen >= poster.onScreen * 3, 'most icons start off-screen (~4x)',
    `(${poster.onScreen} on-screen, ${poster.offScreen} off-screen)`)
  ok(poster.centeredX < 4, 'prompt is horizontally centered', `(Δ=${poster.centeredX.toFixed(1)}px)`)
  ok(poster.fromBottom > 60 && poster.fromBottom < 260, 'prompt sits near the bottom',
    `(${poster.fromBottom}px from bottom)`)

  // Poster must WAIT — no auto-play. It should still be idle after a beat.
  await sleep(700)
  ok((await page.locator('.intro.intro--idle').count()) === 1, 'poster waits for click (no auto-play)')

  // --- Click to start; sample the phase + logo scale over the whole sequence ---
  await page.locator('.intro').click()
  const samples = []
  let grewShot = false
  let tintColors = null
  let convergeMs = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 9000) {
    const s = await page.evaluate(() => {
      const el = document.querySelector('.intro')
      if (!el) return null
      const m = getComputedStyle(el.querySelector('.intro__logo')).transform
      let scale = 1
      if (m && m.startsWith('matrix')) scale = parseFloat(m.slice(7).split(',')[0])
      return { phase: (el.className.match(/intro--(\w+)/) || [])[1], scale: +scale.toFixed(3) }
    })
    if (s === null) break
    samples.push({ ...s, t: Date.now() - t0 })
    if (s.phase === 'grow' && !grewShot) {
      grewShot = true
      convergeMs = Date.now() - t0 // time from click until the fly-in finished
      // Movement is done → icons have reached their final tint.
      tintColors = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.intro__icon-inner')).map(
          (el) => getComputedStyle(el).color
        )
      )
      await shot(page, 'intro-grow')
    }
    await sleep(55)
  }
  await page.waitForSelector('.intro', { state: 'detached', timeout: 7000 })
  await shot(page, 'app-after-intro')

  const phases = [...new Set(samples.map((s) => s.phase))]
  const maxScale = Math.max(...samples.map((s) => s.scale))
  const peakIdx = samples.findIndex((s) => s.scale === maxScale)
  const minAfterPeak = Math.min(...samples.slice(peakIdx).map((s) => s.scale))
  // The pause: from when the logo has settled back to ~1 until the reveal fade.
  const settleDone = samples.slice(peakIdx).find((s) => s.scale <= 1.02)
  const revealSample = samples.find((s) => s.phase === 'reveal')
  const holdMs = settleDone && revealSample ? revealSample.t - settleDone.t : 0
  console.log('  phases:', phases.join(' → '), '| convergeMs:', convergeMs,
    '| maxScale:', maxScale, '| minAfterPeak:', minAfterPeak, '| holdMs:', holdMs)

  ok((await page.locator('.intro').count()) === 0 || samples.length > 0, 'click starts the animation')
  ok(phases.includes('grow') && phases.includes('settle'), 'sequence zooms (grow) then returns (settle)')
  ok(convergeMs >= 1800, 'fly-in runs longer than before', `(${convergeMs}ms of converge)`)
  ok(maxScale >= 1.06, 'logo zooms in ~10%', `(peak scale ${maxScale})`)
  ok(minAfterPeak <= 1.03, 'logo returns to original size', `(min after peak ${minAfterPeak})`)
  ok(holdMs >= 900, 'holds ~1s on the logo before revealing', `(${holdMs}ms hold)`)

  // Icons should have ignited from white to random icon-set colors by end of move.
  ok(tintColors && tintColors.length > 15, 'captured icon colors at end of movement',
    `(${tintColors ? tintColors.length : 0})`)
  const tinted = (tintColors || []).filter((c) => paletteRgb.has(c)).length
  ok(tintColors && tinted === tintColors.length, 'every icon reached an icon-set color (not white)',
    `(${tinted}/${tintColors ? tintColors.length : 0})`)
  ok(new Set(tintColors || []).size > 1, 'colors are randomized across icons',
    `(${new Set(tintColors || []).size} distinct)`)
  console.log('  ✓ animation played and revealed the app')

  await app.close()
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
