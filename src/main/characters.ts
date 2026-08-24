// The character roster. MVP art is an emoji-glyph fallback (SPEC §7.4 allows
// upgrading to real sprites later). New sessions get a distinct character while
// any are free; once every character is in use we spread evenly by handing out
// a least-used one (random tiebreak) so the roster stays varied.

import type { CharacterDef } from '../shared/types'

export const CHARACTERS: CharacterDef[] = [
  { id: 'fox', name: 'Fox', glyph: '🦊', color: '#e8833a' },
  { id: 'bear', name: 'Bear', glyph: '🐻', color: '#8a5a2b' },
  { id: 'deer', name: 'Deer', glyph: '🦌', color: '#a9744e' },
  { id: 'owl', name: 'Owl', glyph: '🦉', color: '#b08968' },
  { id: 'rabbit', name: 'Rabbit', glyph: '🐰', color: '#b8b2a8' },
  { id: 'squirrel', name: 'Squirrel', glyph: '🐿️', color: '#c56b3e' },
  { id: 'raccoon', name: 'Raccoon', glyph: '🦝', color: '#8b8b8b' },
  { id: 'hedgehog', name: 'Hedgehog', glyph: '🦔', color: '#b5835a' },
  { id: 'lion', name: 'Lion', glyph: '🦁', color: '#d1a33a' },
  { id: 'monkey', name: 'Monkey', glyph: '🐵', color: '#9c6b4a' },
  { id: 'frog', name: 'Frog', glyph: '🐸', color: '#5fb85f' },
  { id: 'elephant', name: 'Elephant', glyph: '🐘', color: '#9098a0' },
  { id: 'koala', name: 'Koala', glyph: '🐨', color: '#9ba7b0' },
  { id: 'panda', name: 'Panda', glyph: '🐼', color: '#9aa0a6' },
  { id: 'penguin', name: 'Penguin', glyph: '🐧', color: '#6c8ebf' },
  { id: 'duck', name: 'Duck', glyph: '🦆', color: '#e0b84a' },
  { id: 'cat', name: 'Cat', glyph: '🐱', color: '#a7a2ad' },
  { id: 'dog', name: 'Dog', glyph: '🐶', color: '#cf9b62' },
  { id: 'tiger', name: 'Tiger', glyph: '🐯', color: '#db7f2b' },
  { id: 'pig', name: 'Pig', glyph: '🐷', color: '#e6a0ab' },
  { id: 'wolf', name: 'Wolf', glyph: '🐺', color: '#8b95a1' },
  { id: 'cow', name: 'Cow', glyph: '🐮', color: '#d5cabb' },
  { id: 'horse', name: 'Horse', glyph: '🐴', color: '#a5673a' },
  { id: 'mouse', name: 'Mouse', glyph: '🐭', color: '#b6aeb0' },
  { id: 'hamster', name: 'Hamster', glyph: '🐹', color: '#cf9f5a' },
  { id: 'sheep', name: 'Sheep', glyph: '🐑', color: '#e4ded3' },
  { id: 'goat', name: 'Goat', glyph: '🐐', color: '#bcae97' },
  { id: 'rooster', name: 'Rooster', glyph: '🐔', color: '#cf5245' },
  { id: 'hippo', name: 'Hippo', glyph: '🦛', color: '#a291a8' },
  { id: 'rhino', name: 'Rhino', glyph: '🦏', color: '#94969c' },
  { id: 'giraffe', name: 'Giraffe', glyph: '🦒', color: '#d6a03e' },
  { id: 'llama', name: 'Llama', glyph: '🦙', color: '#c9a878' }
]

export function getCharacter(id: string): CharacterDef | undefined {
  return CHARACTERS.find((c) => c.id === id)
}

/** True when `id` is a real character (guards against stray ids, e.g. a session UUID). */
export function isCharacterId(id: string | undefined | null): boolean {
  return id != null && CHARACTERS.some((c) => c.id === id)
}

/**
 * Pick a character for a new session, minimizing duplication.
 * - Honor `preferred` (e.g. a remembered assignment) when it is a real character
 *   that is not currently in use, so the same job keeps its character across
 *   relaunches.
 * - Otherwise return the first character that is not in use at all (list order,
 *   so early sessions get a stable, varied roster).
 * - Once every character is in use, choose among the *least-used* ones with a
 *   random tiebreak. This spreads new sessions evenly instead of getting stuck
 *   repeatedly handing out `CHARACTERS[0]`.
 *
 * `used` is the collection of in-use character ids. Pass an array (which may
 * contain duplicates) so usage counts inform the least-used pick; a Set also
 * works when only distinctness matters.
 */
export function pickCharacter(used: Iterable<string>, preferred?: string): string {
  const counts = new Map<string, number>()
  for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1)
  const countOf = (id: string): number => counts.get(id) ?? 0

  if (preferred && isCharacterId(preferred) && countOf(preferred) === 0) return preferred

  for (const c of CHARACTERS) {
    if (countOf(c.id) === 0) return c.id
  }
  // Every character is in use — pick a least-used one, breaking ties at random
  // so consecutive new sessions don't all land on the same character.
  const min = Math.min(...CHARACTERS.map((c) => countOf(c.id)))
  const leastUsed = CHARACTERS.filter((c) => countOf(c.id) === min)
  return leastUsed[Math.floor(Math.random() * leastUsed.length)].id
}
