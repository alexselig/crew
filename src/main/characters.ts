// The character roster. MVP art is an emoji-glyph fallback (SPEC §7.4 allows
// upgrading to real sprites later). Each active session gets a distinct
// character; assignment is deterministic (next unused, in list order) so the
// roster feels stable.

import type { CharacterDef } from '../shared/types'

export const CHARACTERS: CharacterDef[] = [
  { id: 'fox', name: 'Fox', glyph: '🦊', color: '#e8833a' },
  { id: 'owl', name: 'Owl', glyph: '🦉', color: '#b08968' },
  { id: 'otter', name: 'Otter', glyph: '🦦', color: '#9c7a5b' },
  { id: 'cat', name: 'Cat', glyph: '🐱', color: '#c9a227' },
  { id: 'frog', name: 'Frog', glyph: '🐸', color: '#5fb85f' },
  { id: 'octopus', name: 'Octopus', glyph: '🐙', color: '#d16ba5' },
  { id: 'penguin', name: 'Penguin', glyph: '🐧', color: '#6c8ebf' },
  { id: 'bee', name: 'Bee', glyph: '🐝', color: '#e0b000' },
  { id: 'wolf', name: 'Wolf', glyph: '🐺', color: '#8a94a6' },
  { id: 'panda', name: 'Panda', glyph: '🐼', color: '#9aa0a6' },
  { id: 'crab', name: 'Crab', glyph: '🦀', color: '#e05a4a' },
  { id: 'unicorn', name: 'Unicorn', glyph: '🦄', color: '#b892ff' },
  { id: 'dragon', name: 'Dragon', glyph: '🐲', color: '#4caf7d' },
  { id: 'robot', name: 'Robot', glyph: '🤖', color: '#7aa2f7' },
  { id: 'hedgehog', name: 'Hedgehog', glyph: '🦔', color: '#b5835a' },
  { id: 'koala', name: 'Koala', glyph: '🐨', color: '#9ba7b0' },
  { id: 'parrot', name: 'Parrot', glyph: '🦜', color: '#43b581' },
  { id: 'raccoon', name: 'Raccoon', glyph: '🦝', color: '#8b8b8b' }
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
