import {
  DEFAULT_COPILOT_MODEL,
  withCopilotModel,
  type CopilotModelCatalog
} from '../shared/copilot-models'
import type { LaneAgent } from '../shared/conductor'
import type { SessionInfo } from '../shared/types'
import { isProjectDir, trimDir } from '../shared/project-dir'

export { isProjectDir } from '../shared/project-dir'

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

/** Why an existing session looks like the job the user is about to start again. */
export type ResumeReason = 'label' | 'directory' | 'label+directory'

export interface ResumeCandidate {
  session: SessionInfo
  reason: ResumeReason
}

export interface ResumeDraft {
  label: string
  cwd: string
  /** A session that must never match itself. */
  excludeId?: string
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Last meaningful activity: a real prompt if there was one, else creation. */
function lastTouched(s: SessionInfo): number {
  return s.lastPromptAt ?? s.createdAt
}

const RANK: Record<ResumeReason, number> = { 'label+directory': 3, label: 2, directory: 1 }

/**
 * The existing session a new one would duplicate, or null.
 *
 * Roughly one session in five is a second run at a job already started —
 * twelve labels in the real store each occur twice ("Fix Icon Positioning
 * Bug", "Create Project Tracker Site", …) — and each duplicate strands the
 * earlier session's context. Offering to resume turns that into a choice.
 *
 * Directory matching deliberately ignores `homeDir`. Every session in the
 * store launched in $HOME, so treating home as a project would nominate an
 * unrelated session on literally every creation, which is worse than saying
 * nothing. Only a real project directory counts as evidence.
 *
 * A failed-to-start session is never offered: it has no context to strand.
 * An exited one is, because that is exactly where context goes cold.
 */
export function findResumeCandidate(
  draft: ResumeDraft,
  sessions: readonly SessionInfo[],
  homeDir: string
): ResumeCandidate | null {
  const wantLabel = normalizeLabel(draft.label)
  const wantCwd = draft.cwd.trim().replace(/\/+$/, '')
  const homeCwd = homeDir.trim().replace(/\/+$/, '')
  const cwdIsProject = wantCwd.length > 0 && wantCwd !== homeCwd

  let best: ResumeCandidate | null = null
  for (const s of sessions) {
    if (s.id === draft.excludeId) continue
    if (s.status === 'error') continue

    const labelHit = wantLabel.length > 0 && normalizeLabel(s.label) === wantLabel
    const dirHit = cwdIsProject && s.cwd.trim().replace(/\/+$/, '') === wantCwd
    if (!labelHit && !dirHit) continue

    const reason: ResumeReason = labelHit && dirHit ? 'label+directory' : labelHit ? 'label' : 'directory'
    if (
      best === null ||
      RANK[reason] > RANK[best.reason] ||
      (RANK[reason] === RANK[best.reason] && lastTouched(s) > lastTouched(best.session))
    ) {
      best = { session: s, reason }
    }
  }
  return best
}

/**
 * The directory a new session should start in.
 *
 * Preference order: the directory this same label was last worked in, then
 * the most recent project directory, then home. Prior sessions that only ever
 * ran in home are ignored — all of them currently are — otherwise the
 * suggestion would always be home and the field would stay as invisible as it
 * is today.
 */
export function suggestCwd(
  label: string,
  sessions: readonly SessionInfo[],
  recentDirs: readonly string[],
  homeDir: string
): string {
  const want = normalizeLabel(label)
  if (want.length > 0) {
    let best: SessionInfo | null = null
    for (const s of sessions) {
      if (normalizeLabel(s.label) !== want) continue
      if (!isProjectDir(s.cwd, homeDir)) continue
      if (best === null || lastTouched(s) > lastTouched(best)) best = s
    }
    if (best) return trimDir(best.cwd)
  }
  const recent = recentDirs.find((d) => isProjectDir(d, homeDir))
  return recent ? trimDir(recent) : homeDir
}
