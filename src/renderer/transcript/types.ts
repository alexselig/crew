/**
 * Transcript block model — the typed stream a session's scrollback renders.
 *
 * Each block is one addressable unit in the conversation between the human and
 * an agent: prompts, prose, tool runs, diffs, images, and the two "blocked on
 * you" shapes (decisions and permission requests). Feed these from PTY stream
 * parsing; the renderer never re-parses raw terminal output.
 */

export interface DiffLine {
  /** '+' added, '-' removed, ' ' context */
  op: '+' | '-' | ' '
  /** Line number shown in the gutter (post-edit for adds, pre-edit for dels). */
  ln: number
  text: string
}

export interface DecisionOption {
  id: string
  /** Short mono label, e.g. "localStorage". */
  label: string
  /** One-line tradeoff shown under the label. */
  detail?: string
}

export interface PlanItem {
  id: string
  text: string
  status: 'done' | 'active' | 'todo'
}

/** A clickable follow-up rendered inside a block (e.g. "Apply rename"). */
export interface BlockAction {
  id: string
  label: string
}

export type PermissionResolution = 'deny' | 'once' | 'always'

interface Base {
  id: string
  /** Epoch ms; shown in block metadata when present. */
  ts?: number
}

export interface UserBlock extends Base {
  kind: 'user'
  text: string
}

export interface AgentTextBlock extends Base {
  kind: 'agent'
  /** Plain text; `inline code` between backticks is styled. */
  text: string
}

export interface ThinkingBlock extends Base {
  kind: 'thinking'
  body: string
  durationMs?: number
}

export interface ToolRunBlock extends Base {
  kind: 'tool'
  command: string
  output?: string
  /** undefined while running. */
  exitCode?: number
  durationMs?: number
}

export interface FileDiffBlock extends Base {
  kind: 'diff'
  file: string
  lines: DiffLine[]
}

export interface ImageBlock extends Base {
  kind: 'image'
  /** Any <img> src: file://, data:, or app-served URL. */
  src: string
  alt?: string
  caption?: string
}

export interface DecisionBlock extends Base {
  kind: 'decision'
  question: string
  options: DecisionOption[]
  /** Set once the human answers; renders the chosen option and disables the rest. */
  resolvedOptionId?: string
}

export interface PermissionBlock extends Base {
  kind: 'permission'
  /** The command the agent wants to run, shown verbatim. */
  command: string
  /** Who's asking — the session character's name, e.g. "Fox". */
  actor?: string
  resolution?: PermissionResolution
}

export interface ErrorBlock extends Base {
  kind: 'error'
  title: string
  /** Preformatted detail (compiler output, stack excerpt). */
  detail?: string
  /** Suggested-fix hint rendered before the actions. */
  hint?: string
  actions?: BlockAction[]
}

export interface PlanBlock extends Base {
  kind: 'plan'
  items: PlanItem[]
}

export type TranscriptBlock =
  | UserBlock
  | AgentTextBlock
  | ThinkingBlock
  | ToolRunBlock
  | FileDiffBlock
  | ImageBlock
  | DecisionBlock
  | PermissionBlock
  | ErrorBlock
  | PlanBlock

/** Callbacks the host wires to session logic. All are optional. */
export interface TranscriptHandlers {
  /** Human picked an option on an unresolved decision block. */
  onDecide?: (blockId: string, optionId: string) => void
  /** Human resolved a permission request. */
  onPermission?: (blockId: string, resolution: PermissionResolution) => void
  /** Human clicked a block action (e.g. error-fix link). */
  onAction?: (blockId: string, actionId: string) => void
  /** Human asked to open an image full size. */
  onOpenImage?: (blockId: string) => void
}
