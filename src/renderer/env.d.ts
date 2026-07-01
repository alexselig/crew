import type { CrewAPI } from '../shared/api'

declare global {
  interface Window {
    crew: CrewAPI
  }
}

declare module '*.css'
