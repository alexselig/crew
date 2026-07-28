// Global ambient declarations shared by every tsconfig (node + web). Lives in
// src/shared so that both the renderer build AND any test that transitively
// imports renderer code (e.g. the terminal facade routing test, compiled under
// tsconfig.node) see the typed `window.crew` bridge and CSS module shims.

import type { CrewAPI } from './api'

declare global {
  interface Window {
    crew: CrewAPI
  }
}

declare module '*.css'
