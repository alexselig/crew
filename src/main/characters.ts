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
 * Pick the next character for a new session.
 * - Honor `preferred` (e.g. a remembered assignment) when it is a real, free character.
 * - Otherwise return the first character not currently in use.
 * - If every character is in use, cycle deterministically so we never crash.
 */
export function pickCharacter(used: Set<string>, preferred?: string): string {
  if (preferred && isCharacterId(preferred) && !used.has(preferred)) return preferred
  for (const c of CHARACTERS) {
    if (!used.has(c.id)) return c.id
  }
  return CHARACTERS[used.size % CHARACTERS.length].id
}
