// The character roster. MVP art is an emoji-glyph fallback (SPEC §7.4 allows
// upgrading to real sprites later). Each active session gets a distinct
// character; assignment is deterministic (next unused, in list order) so the
// roster feels stable.

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
  { id: 'duck', name: 'Duck', glyph: '🦆', color: '#e0b84a' }
]

export function getCharacter(id: string): CharacterDef | undefined {
  return CHARACTERS.find((c) => c.id === id)
}

/**
 * Pick the next character for a new session.
 * - Honor `preferred` (e.g. a remembered assignment) when it is free.
 * - Otherwise return the first character not currently in use.
 * - If every character is in use, cycle deterministically so we never crash.
 */
export function pickCharacter(used: Set<string>, preferred?: string): string {
  if (preferred && !used.has(preferred)) return preferred
  for (const c of CHARACTERS) {
    if (!used.has(c.id)) return c.id
  }
  return CHARACTERS[used.size % CHARACTERS.length].id
}
