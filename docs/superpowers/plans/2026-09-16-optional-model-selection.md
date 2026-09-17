# Optional Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep New Session launchable with the Copilot CLI default whenever model discovery is pending, unavailable, or empty.

**Architecture:** Extract the catalog-dependent UI and argument decisions into pure renderer helpers. `NewSessionModal` uses those helpers so model discovery controls only whether the optional dropdown appears, never whether a session can launch.

**Tech Stack:** TypeScript, React, Vitest, existing Copilot model helpers.

## Global Constraints

- While model discovery is loading, hide the Model field and allow Launch.
- If discovery fails or returns no models, hide the Model field and allow Launch.
- Without selectable models, preserve the Copilot preset arguments unchanged and do not add or replace `--model`.
- With selectable models, require a listed selection and launch with `--model <id>`.
- Do not change model discovery, caching, saved-session restore semantics, application version, or release state.
- Do not launch Crew, Electron, Playwright, or GUI E2E on this host.

---

### Task 1: Make Copilot model selection optional

**Files:**
- Create: `src/renderer/new-session-model.ts`
- Modify: `src/renderer/components/NewSessionModal.tsx`
- Create: `test/new-session-model.test.ts`

**Interfaces:**
- Consumes: `CopilotModelCatalog`, a selected model ID, and the Copilot preset argument array.
- Produces:

```ts
export interface CopilotModelSelection {
  visible: boolean
  valid: boolean
}

export function getCopilotModelSelection(
  catalog: CopilotModelCatalog | null,
  selectedModel: string
): CopilotModelSelection

export function getCopilotLaunchArgs(
  presetArgs: string[],
  catalog: CopilotModelCatalog | null,
  selectedModel: string
): string[]
```

- [ ] **Step 1: Write failing pure behavior tests**

Create `test/new-session-model.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  getCopilotLaunchArgs,
  getCopilotModelSelection
} from '../src/renderer/new-session-model'
import type { CopilotModelCatalog } from '../src/shared/copilot-models'

const failed: CopilotModelCatalog = {
  models: [],
  source: 'cli',
  error: 'CLI unavailable'
}

const empty: CopilotModelCatalog = {
  models: [],
  source: 'cli'
}

const available: CopilotModelCatalog = {
  models: ['auto', 'claude-sonnet-5'],
  source: 'cli'
}

describe('optional Copilot model selection', () => {
  it.each([
    ['loading', null],
    ['failed', failed],
    ['empty', empty]
  ])('hides model selection and accepts the CLI default while %s', (_name, catalog) => {
    expect(getCopilotModelSelection(catalog, 'gpt-6-astra')).toEqual({
      visible: false,
      valid: true
    })
    expect(getCopilotLaunchArgs(['--banner'], catalog, 'gpt-6-astra')).toEqual(['--banner'])
  })

  it('shows a successful catalog and rejects an unavailable explicit selection', () => {
    expect(getCopilotModelSelection(available, 'gpt-6-astra')).toEqual({
      visible: true,
      valid: false
    })
  })

  it('adds a listed explicit model without mutating preset arguments', () => {
    const presetArgs = ['--banner', '--model=old']
    expect(getCopilotModelSelection(available, 'auto')).toEqual({
      visible: true,
      valid: true
    })
    expect(getCopilotLaunchArgs(presetArgs, available, 'auto')).toEqual([
      '--banner',
      '--model',
      'auto'
    ])
    expect(presetArgs).toEqual(['--banner', '--model=old'])
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- test/new-session-model.test.ts
```

Expected: FAIL because `src/renderer/new-session-model.ts` does not exist.

- [ ] **Step 3: Implement the pure decision helpers**

Create `src/renderer/new-session-model.ts`:

```ts
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
```

- [ ] **Step 4: Wire `NewSessionModal` to the helpers**

In `src/renderer/components/NewSessionModal.tsx`:

1. Replace the `withCopilotModel` import with:

```ts
import { DEFAULT_COPILOT_MODEL, type CopilotModelCatalog } from '../../shared/copilot-models'
import {
  getCopilotLaunchArgs,
  getCopilotModelSelection
} from '../new-session-model'
```

2. Derive the model state beside `isCopilot`:

```ts
const modelSelection = getCopilotModelSelection(catalog, model)
```

3. Replace model validation with:

```ts
const modelOk = !isCopilot || modelSelection.valid
```

4. Build preset arguments with:

```ts
args: isCopilot
  ? getCopilotLaunchArgs(preset!.args, catalog, model)
  : preset!.args,
```

5. Render the entire Model field only when:

```tsx
{isCopilot && modelSelection.visible && (
```

Inside that field, render only the successful catalog options and existing
unavailable-selection warning/hint. Remove the loading option, disabled state
based on catalog loading/error, model-discovery error alert, and Retry button.
Keep `disabled={creating}` on the visible select.

- [ ] **Step 5: Run focused tests and typechecks**

Run:

```bash
npm test -- test/new-session-model.test.ts test/copilot-models.test.ts
npm run typecheck
```

Expected: all focused tests pass and both TypeScript projects report no errors.

- [ ] **Step 6: Run non-GUI regression verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all unit tests pass, browser-only tests may remain skipped, production
build succeeds, and diff check is clean. Do not run `npm run test:e2e`.

- [ ] **Step 7: Commit the fix**

```bash
git add src/renderer/new-session-model.ts \
  src/renderer/components/NewSessionModal.tsx \
  test/new-session-model.test.ts
git commit -m "fix: allow sessions without model discovery"
```
