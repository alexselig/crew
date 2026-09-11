import { execFile } from 'node:child_process'
import type { CopilotModelCatalog } from '../shared/copilot-models'

const CACHE_MS = 5 * 60_000

/** Completion is CLI-provided metadata. Never source or execute the returned script. */
export function parseCopilotModels(completion: string): string[] {
  const section = completion.match(/(?:^|\n)\s*--model\)\s*([\s\S]*?);;/)?.[1]
  const choices = section?.match(/\bcompgen\s+-W\s+'([^']*)'/)?.[1]
  const models = choices?.trim().split(/\s+/) ?? []
  if (!models.length || models.length > 256 || models.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(id))) {
    throw new Error('The installed Copilot CLI did not provide a valid model list. Update Copilot CLI and retry.')
  }
  return [...new Set(models)]
}

function readCompletion(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Windows npm installs expose a .cmd shim. Only this fixed command enters cmd;
    // model choices and other user input are never interpolated into a shell.
    const windows = process.platform === 'win32'
    const file = windows ? process.env.ComSpec || 'cmd.exe' : 'copilot'
    const args = windows ? ['/d', '/s', '/c', 'copilot completion bash'] : ['completion', 'bash']
    execFile(file, args, {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' }
    }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

export function createModelCatalog(
  run: () => Promise<string> = readCompletion,
  now: () => number = Date.now
): () => Promise<CopilotModelCatalog> {
  let cached: { models: string[]; expires: number } | undefined
  let pending: Promise<CopilotModelCatalog> | undefined
  return async () => {
    if (cached && now() < cached.expires) return { models: [...cached.models], source: 'cli' }
    if (pending) return pending
    pending = (async (): Promise<CopilotModelCatalog> => {
      try {
        const models = parseCopilotModels(await run())
        cached = { models, expires: now() + CACHE_MS }
        return { models: [...models], source: 'cli' }
      } catch (error) {
        const message = `Could not load Copilot models: ${error instanceof Error ? error.message : String(error)}`
        console.warn('[crew]', message)
        return { models: [], source: 'cli', error: message }
      }
    })()
    try {
      return await pending
    } finally {
      pending = undefined
    }
  }
}

export const listCopilotModels = createModelCatalog()
