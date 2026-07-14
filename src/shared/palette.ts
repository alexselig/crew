// Character color palette — 15 vivid rainbow hues plus a neutral grey, offered
// when personalizing a session's character. Bright enough to read against the
// near-black Obsidian bg.
// Used in main (random default at session creation) and the renderer color picker.

export const CHARACTER_COLORS: string[] = [
  '#ff5a5a', // red
  '#ff7a3c', // orange
  '#ff9f2e', // amber
  '#ffd23c', // yellow
  '#c6e04a', // lime
  '#7ed957', // green
  '#45c98a', // emerald
  '#34d0c3', // teal
  '#37c0e6', // cyan
  '#4aa8ff', // sky
  '#8a6dff', // violet
  '#b57cff', // purple
  '#d86fe0', // magenta
  '#ff6fb5', // pink
  '#ff6f8f', // rose
  '#9aa4ad' // grey
]

/** A random color for a brand-new session's character. */
export function randomCharacterColor(): string {
  return CHARACTER_COLORS[Math.floor(Math.random() * CHARACTER_COLORS.length)]
}

/** Stable fallback for sessions persisted before color support existed. */
export function fallbackCharacterColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return CHARACTER_COLORS[h % CHARACTER_COLORS.length]
}

/**
 * A stable, distinct color for a group label, so groups are easy to tell apart in
 * the nav. Hashes the name onto the vivid hues (skipping the trailing neutral grey).
 */
export function groupColor(name: string): string {
  const vivid = CHARACTER_COLORS.slice(0, CHARACTER_COLORS.length - 1)
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return vivid[h % vivid.length]
}
