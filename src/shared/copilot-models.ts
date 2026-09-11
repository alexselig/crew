export const DEFAULT_COPILOT_MODEL = 'gpt-6-astra'

export interface CopilotModelCatalog {
  models: string[]
  source: 'cli'
  error?: string
}

export function withCopilotModel(args: string[], model: string): string[] {
  const next: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      i++
    } else if (!args[i].startsWith('--model=')) {
      next.push(args[i])
    }
  }
  return [...next, '--model', model]
}
