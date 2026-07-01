// Pure, dependency-free session spend parser.
//
// Crew owns the PTY, so it sees everything the agent prints. This scans the
// (ANSI-stripped) output for a cumulative dollar cost the agent reports — e.g.
// Claude Code's `/cost` "Total cost: $0.42" — and tracks the highest value seen
// (session spend is cumulative, so it only ever goes up). Agents that never
// print a dollar figure simply stay at $0.00, which is honest.

export interface CostConfig {
  /** Regex whose capture group 1 is a USD amount. Applied to the output tail. */
  costRegex: RegExp | null
}

// Matches a dollar amount that follows a cost-ish keyword on the same line:
// "Total cost: $0.1234", "cost $1.23", "you spent $0.10", "billed $2".
export const DEFAULT_COST_REGEX_SRC =
  '(?:cost|spent|billed|charge[ds]?|total)[^\\n$]{0,40}\\$\\s?(\\d+(?:\\.\\d+)?)'

export class CostParser {
  private buf = ''
  private _usd = 0
  private readonly re: RegExp | null

  constructor(cfg: CostConfig) {
    this.re = cfg.costRegex ? new RegExp(cfg.costRegex.source, 'gi') : null
  }

  /** Feed an ANSI-stripped chunk. Returns true if the tracked spend increased. */
  push(clean: string): boolean {
    if (!this.re) return false
    this.buf = (this.buf + clean).slice(-6000)
    this.re.lastIndex = 0
    let max = this._usd
    let m: RegExpExecArray | null
    while ((m = this.re.exec(this.buf)) !== null) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v) && v > max) max = v
    }
    if (max !== this._usd) {
      this._usd = max
      return true
    }
    return false
  }

  get usd(): number {
    return this._usd
  }
}
