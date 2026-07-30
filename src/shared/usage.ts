// Shared types for the token-usage analytics shown in the Activity view. The
// data is derived read-only from the aggregate Copilot CLI history
// (~/.copilot/session-store.db, table assistant_usage_events), bucketed into a
// handful of time ranges so the Activity tab can chart token throughput over
// time and rank where those tokens went (by git repo or session).

export type UsageRangeKey = 'hour' | 'day' | 'week' | 'month' | 'year'

/** One column of the over-time bar chart. */
export interface UsageBucket {
  /** Axis label for the bucket start, in local time (e.g. "14:05", "Mon", "Jul"). */
  label: string
  /** Total tokens (input + output) in this bucket. */
  tokens: number
}

/** One row of the "project intensity" ranking — a repo or a session. */
export interface UsageSlice {
  name: string
  tokens: number
  /** Whether this slice is attributed to a git repo or a bare session. */
  kind: 'repo' | 'session'
}

/** A single selectable range (past hour … past year) with its chart + ranking. */
export interface UsageRangeData {
  key: UsageRangeKey
  /** Short toggle label, e.g. "1h", "24h", "7d", "30d", "1y". */
  short: string
  /** Human title, e.g. "Past hour", "Past 24 hours". */
  title: string
  /** Bucket describing how the window is divided, e.g. "5-min buckets". */
  bucketLabel: string
  series: UsageBucket[]
  totalTokens: number
  /** Total credits (AIU) billed in the window, derived from total_nano_aiu. */
  totalAiu: number
  /** Label of the busiest bucket, or null when the window is empty. */
  peakLabel: string | null
  /** Top slices by token volume (repos, with a session fallback). */
  projects: UsageSlice[]
  /**
   * Per-project over-time series, keyed by the project/slice name that appears
   * in `projects`. Each array is bucket-aligned with `series` (same length and
   * labels), so the Activity chart can filter to a single project. The global
   * `series` above is the "All projects" view. */
  seriesByProject: Record<string, UsageBucket[]>
}

export interface UsageAnalytics {
  /** True when the Copilot history DB was found and read. */
  available: boolean
  generatedAt: number
  /** Ordered hour → year. */
  ranges: UsageRangeData[]
}
