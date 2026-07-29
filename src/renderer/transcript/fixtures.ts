import type { TranscriptBlock } from './types'

/** The scrollback from the design mockup, as data. Render with <Transcript blocks={DEMO_BLOCKS} /> */
export const DEMO_BLOCKS: TranscriptBlock[] = [
  {
    kind: 'user',
    id: 'u1',
    ts: Date.now() - 6 * 60_000,
    text:
      'Add a settings screen with a temperature-threshold slider, then wire it into the notification logic. Show me a preview when it renders.'
  },
  {
    kind: 'thinking',
    id: 't1',
    durationMs: 6000,
    body:
      'The threshold currently lives as a constant in notify.ts. Cleanest path: a Settings store persisted to localStorage, slider bound to it, and notify.ts reads from the store instead of the constant.'
  },
  {
    kind: 'agent',
    id: 'a1',
    text:
      "I'll add a `SettingsScreen` component with a persisted store, then update `notify.ts` to read the threshold from it. Starting with the store."
  },
  {
    kind: 'tool',
    id: 'r1',
    command: 'npm test -- settings.store',
    exitCode: 0,
    durationMs: 1200,
    output:
      'PASS  src/store/settings.store.test.ts\n  ✓ defaults threshold to 62°F (3 ms)\n  ✓ persists slider changes (5 ms)\n  ✓ clamps values to 40–85 (2 ms)\n\nTests: 3 passed · Time: 0.84s'
  },
  {
    kind: 'diff',
    id: 'd1',
    file: 'src/notify.ts',
    lines: [
      { op: ' ', ln: 14, text: 'export function shouldNotify(temp: number) {' },
      { op: '-', ln: 15, text: '  const THRESHOLD = 62;' },
      { op: '-', ln: 16, text: '  return temp >= THRESHOLD;' },
      { op: '+', ln: 15, text: '  const { threshold } = useSettings.getState();' },
      { op: '+', ln: 16, text: '  return temp >= threshold;' },
      { op: ' ', ln: 17, text: '}' }
    ]
  },
  {
    kind: 'decision',
    id: 'q1',
    question: 'Where should the threshold setting persist?',
    options: [
      { id: 'ls', label: 'localStorage', detail: 'Zero setup, per-device. Matches how the app stores units today.' },
      {
        id: 'cfg',
        label: '~/.windowapp/config.json',
        detail: 'Survives cache clears, editable by hand, easy to sync later.'
      },
      { id: 'skip', label: 'Skip persistence for now', detail: 'Keep it in memory; decide storage after the UI settles.' }
    ]
  },
  {
    kind: 'permission',
    id: 'p1',
    command: 'rm -rf node_modules && npm ci'
  },
  {
    kind: 'error',
    id: 'e1',
    title: 'Type error in src/screens/Settings.tsx',
    detail: "TS2339: Property 'threshold' does not exist on type 'SettingsState'.\n  → line 41: value={settings.threshold}",
    hint: 'Fix: the store field is named tempThreshold.',
    actions: [
      { id: 'rename', label: 'Apply rename' },
      { id: 'show', label: 'Show file' }
    ]
  },
  {
    kind: 'plan',
    id: 'pl1',
    items: [
      { id: '1', text: 'Create settings store with persistence', status: 'done' },
      { id: '2', text: 'Build SettingsScreen with slider', status: 'done' },
      { id: '3', text: 'Wire threshold into notify.ts', status: 'active' },
      { id: '4', text: 'Add quiet-hours toggle', status: 'todo' }
    ]
  }
]

/**
 * Second scenario (production-debugging on api-server): exercises the states the
 * first demo doesn't — a live RUNNING command, a failed run next to a collapsed
 * success, and a resolved decision in its quiet state alongside a live one.
 */
export const DEMO_BLOCKS_DEBUG: TranscriptBlock[] = [
  {
    kind: 'user',
    id: 'u1',
    ts: Date.now() - 9 * 60_000,
    text:
      'The /forecast endpoint is timing out in production. Find the cause, fix it, and deploy — ask me before touching the database.'
  },
  { kind: 'agent', id: 'a1', text: 'Checking the production logs first, then profiling the endpoint locally.' },
  {
    kind: 'tool',
    id: 'r1',
    command: 'tail -200 /var/log/api/prod.log | grep forecast',
    exitCode: 0,
    durationMs: 900,
    output:
      '4:01:12 WARN  /forecast 8143ms — slow query: SELECT * FROM readings ...\n4:01:44 ERROR /forecast 30000ms — upstream timeout\n4:01:58 ERROR /forecast 30000ms — upstream timeout'
  },
  {
    kind: 'tool',
    id: 'r2',
    command: 'npm run profile -- /forecast',
    exitCode: 1,
    durationMs: 8400,
    output:
      'Profiling GET /forecast …\n  db.readings.findAll        8,102ms  ← 97% of request time\n  full table scan: readings (2.4M rows), no index on (station_id, ts)\n\nError: request exceeded 8s budget'
  },
  {
    kind: 'agent',
    id: 'a2',
    text:
      "Found it — `readings` is doing a full table scan on 2.4M rows. An index on `(station_id, ts)` fixes it, but that's a database change, so it's your call:"
  },
  {
    kind: 'decision',
    id: 'q1',
    question: 'How should I apply the index migration?',
    options: [
      {
        id: 'concurrent',
        label: 'CREATE INDEX CONCURRENTLY',
        detail: 'No table lock; safe during traffic. Takes ~4 min on 2.4M rows.'
      },
      {
        id: 'window',
        label: "Regular CREATE INDEX in tonight's window",
        detail: 'Brief write lock; schedule for the 2 am maintenance window.'
      },
      {
        id: 'rewrite',
        label: 'Query rewrite only, no migration',
        detail: 'Cap the scan with a time-bounded query. Slower, but zero DB changes.'
      }
    ]
  },
  {
    kind: 'decision',
    id: 'q2',
    question: 'Deploy target for the fix?',
    resolvedOptionId: 'staged',
    options: [
      { id: 'staged', label: 'Staging first, then prod on green checks', detail: 'Canary on staging for 10 min before promoting.' },
      { id: 'prod', label: 'Straight to prod', detail: 'Fastest, no safety net.' }
    ]
  },
  { kind: 'permission', id: 'p1', command: 'npx sequelize db:migrate --env production' },
  { kind: 'tool', id: 'r3', command: 'npm run deploy -- staging' },
  {
    kind: 'agent',
    id: 'a3',
    text: 'Staging is green — p95 dropped from 8.1s to 190ms. Waiting on your approval above to run the production migration.'
  }
]
