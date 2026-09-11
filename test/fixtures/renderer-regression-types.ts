import type { TranscriptBlock } from '../../src/renderer/transcript/types'

export interface RendererRegressionControls {
  activeWorkspace: string | null
  selected: string[]
  modes: string[]
  newDialogs: boolean[]
  windows: number
  sent: { id: string; data: string }[]
  workspace: (id: string | null) => void
  pilot: (value: boolean) => void
  legacy: () => void
  transcript: () => TranscriptBlock[]
  complete: () => void
  pending: () => number
}

declare global {
  var regression: RendererRegressionControls
}
