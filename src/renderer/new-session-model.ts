import {
  withCopilotModel,
  type CopilotModelCatalog
} from '../shared/copilot-models'

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

export function getCopilotLaunchArgs(
  presetArgs: string[],
  catalog: CopilotModelCatalog | null,
  selectedModel: string
): string[] {
  return getCopilotModelSelection(catalog, selectedModel).visible
    ? withCopilotModel(presetArgs, selectedModel)
    : [...presetArgs]
}
