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
  holdCustomViewWrites: boolean
  focusedTerminals: string[]
  gridScrolls: number
  paletteSessionItems: string[]
  workspace: (id: string | null) => void
  pilot: (value: boolean) => void
  present: (value: string) => void
  view: (value: 'single' | 'grid') => void
  removeOrganizerView: () => void
  releaseCustomViewWrite: () => void
  legacy: () => void
  transcript: () => TranscriptBlock[]
  complete: () => void
  pending: () => number
  replay: { control: string; rebuilt: string } | null
  replayAlt: { control: string; rebuilt: string; controlAlt: boolean; rebuiltAlt: boolean } | null
}

declare global {
  var regression: RendererRegressionControls
}
