// Pure command-block assembly. Turns the ordered OSC marks from osc.ts into a
// list of "blocks" — one per shell command / agent turn — with exit code, cwd,
// command text, and timing. Dependency-free (no DOM/xterm) so it is unit-tested
// in Node and could also run in main. Row/marker association with the rendered
// grid is intentionally NOT modeled here (that needs the engine's cursor line
// and belongs to the renderer); this layer is the semantic model.

import type { OscEvent } from './osc'

export type BlockState = 'prompting' | 'running' | 'done'

export interface Block {
  id: number
  command?: string
  cwd?: string
  exitCode?: number
  state: BlockState
  startedAt: number
  endedAt?: number
}

export class BlockTracker {
  private readonly blocks: Block[] = []
  private seq = 0
  private current: Block | null = null

  /** Apply one semantic mark at time `now` (ms). */
  apply(e: OscEvent, now: number): void {
    switch (e.kind) {
      case 'prompt-start':
        this.current = { id: ++this.seq, state: 'prompting', startedAt: now }
        this.blocks.push(this.current)
        break
      case 'input-start':
        if (this.current) this.current.state = 'prompting'
        break
      case 'command-text':
        if (this.current) this.current.command = e.data
        break
      case 'output-start':
        if (!this.current) {
          this.current = { id: ++this.seq, state: 'running', startedAt: now }
          this.blocks.push(this.current)
        } else {
          this.current.state = 'running'
        }
        break
      case 'command-end':
        if (this.current) {
          this.current.state = 'done'
          this.current.exitCode = e.exitCode
          this.current.endedAt = now
        }
        this.current = null
        break
      case 'cwd':
        if (this.current) this.current.cwd = e.cwd
        break
      case 'notify':
        // Not a block boundary; notifications are handled by the caller.
        break
    }
  }

  /** A copy of the block list, oldest first. */
  list(): Block[] {
    return this.blocks.slice()
  }

  get size(): number {
    return this.blocks.length
  }
}
