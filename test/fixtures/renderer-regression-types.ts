import type { TranscriptBlock } from '../../src/renderer/transcript/types'
import type { CustomView, CustomViewMode } from '../../src/shared/types'

export interface CustomViewWrite {
  name: string
  mode: CustomViewMode
  items: CustomView['items']
}

export interface RendererRegressionControls {
  activeWorkspace: string | null
  currentSelected: string | null
  selected: string[]
  modes: string[]
  presentations: string[]
  newDialogs: boolean[]
  windows: number
  sent: { id: string; data: string }[]
  reorders: string[][]
  createdCustomViews: number
  editedCustomViewIds: string[]
  customViewCreates: CustomViewWrite[]
  customViewUpdates: Array<{ id: string; input: CustomViewWrite }>
  customViewDeletes: string[]
  failCustomViewWrites: boolean
  paletteSessionItems: string[]
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
