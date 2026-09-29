import {
  DEFAULT_COPILOT_MODEL,
  withCopilotModel,
  type CopilotModelCatalog
} from '../shared/copilot-models'
import type { LaneAgent } from '../shared/conductor'

export interface CopilotModelSelection {
  visible: boolean
  valid: boolean
}

export function getCopilotModelSelection(
  catalog: CopilotModelCatalog | null,
  selectedModel: string
): CopilotModelSelection {
  const visible = catalog != null && !catalog.error && catalog.models.length > 0
  return {
    visible,
    valid: !visible || catalog.models.includes(selectedModel)
  }
}

/** A new roster row's agent for a freshly chosen preset. Copilot presets take
 *  a model that the UI always shows *some* value for (DEFAULT_COPILOT_MODEL
 *  when nothing else is picked), so a row's stored `model` must default to
 *  that same value the instant the preset is chosen — otherwise the row
 *  looks valid (the picker shows a model) while `model` is still `null` and
 *  validation actually rejects it. */
export function defaultLaneAgent(presetId: string): LaneAgent {
  return { presetId, model: presetId === 'copilot-cli' ? DEFAULT_COPILOT_MODEL : null }
}

export function getCopilotLaunchArgs(
  presetArgs: string[],
  catalog: CopilotModelCatalog | null,
  selectedModel: string
): string[] {
  return getCopilotModelSelection(catalog, selectedModel).visible
    ? withCopilotModel(presetArgs, selectedModel)
    : [...presetArgs]
}
