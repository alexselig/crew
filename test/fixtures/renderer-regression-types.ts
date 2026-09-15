import type { TranscriptBlock } from '../../src/renderer/transcript/types'

export interface RendererRegressionControls {
  activeWorkspace: string | null
  selected: string[]
  modes: string[]
  presentations: string[]
  newDialogs: boolean[]
  windows: number
  sent: { id: string; data: string }[]
  reorders: string[][]
  createdCustomViews: number
  editedCustomViewIds: string[]
  workspace: (id: string | null) => void
  pilot: (value: boolean) => void
  present: (value: string) => void
  legacy: () => void
  transcript: () => TranscriptBlock[]
  complete: () => void
  pending: () => number
}

declare global {
  var regression: RendererRegressionControls
}
