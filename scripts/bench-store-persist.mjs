import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const root = join(process.cwd(), '.bench-runtime', 'store-persist')
const path = join(root, 'store.json')
const warmup = Number(process.env.BENCH_WARMUP ?? 20)
const samples = Number(process.env.BENCH_SAMPLES ?? 120)

function syncParentDirectory(file) {
  if (process.platform === 'win32') return
  const fd = openSync(dirname(file), 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function atomicWriteFile(file, contents, { fsync = true } = {}) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, contents)
    if (fsync) fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
  if (fsync) syncParentDirectory(file)
}

function makeStore(targetBytes = 86 * 1024) {
  const store = {
    characters: {},
    settings: {
      notifications: true,
      sound: false,
      notifyOnlyWhenUnfocused: false,
      sortNeedsYouFirst: true,
      launchAtLogin: false,
      showSpend: true,
      showCredits: false,
      costMode: 'auto',
      aicPerUsd: 100,
      resumeConversations: true,
      contextMode: 'auto',
      budgetUsd: 0,
      inputTokenWarn: 100000,
      captureTranscripts: false,
      staleHideHours: 72,
      minimizedAsList: true,
      enhancedTerminal: false,
      showGithubButton: true,
      githubButtonOpensRepo: true
    },
    recentDirs: [],
    sessions: [],
    sets: [],
    workspaces: [],
    customViews: [],
    agents: [],
    migrations: [
      '2026-07-stale-hide-72h',
      '2026-08-workspaces-firstclass',
      '2026-08-context-mode-auto',
      '2026-08-agents-seed'
    ]
  }
  for (let i = 0; JSON.stringify(store).length < targetBytes; i++) {
    store.sessions.push({
      id: `session-${i}`,
      presetId: 'copilot-cli',
      command: 'copilot',
      args: [],
      cwd: `/Users/alexselig/projects/project-${i % 24}`,
      label: `Benchmark session ${i}`,
      characterId: ['lion', 'fox', 'owl', 'otter'][i % 4],
      color: '#ff7a3c',
      tag: i % 3 === 0 ? 'perf' : undefined,
      sets: [`Workspace ${i % 8}`],
      workspaceIds: [`workspace-${i % 8}`],
      description: `Synthetic persisted session ${i} sized to mirror an 86 KB production Crew store.`,
      agentSessionId: randomUUID(),
      priorSessionId: i % 7 === 0 ? randomUUID() : undefined,
      createdAt: 1790010000000 - i * 1000,
      lastPromptAt: 1790010000000 - i * 500
    })
  }
  return store
}

function parseStore(contents) {
  return JSON.parse(contents)
}

function seedFiles(store, pretty = false) {
  mkdirSync(root, { recursive: true })
  const primary = JSON.stringify(store, null, pretty ? 2 : 0)
  const older = JSON.stringify({ ...store, sessions: store.sessions.slice(0, -1) }, null, pretty ? 2 : 0)
  writeFileSync(path, primary)
  writeFileSync(`${path}.bak`, older)
  return primary
}

function timed(metrics, name, fn) {
  const start = performance.now()
  const result = fn()
  metrics[name] += performance.now() - start
  return result
}

function legacyPersist(store) {
  const metrics = { rotateBackups: 0, stringify: 0, atomicWriteFile: 0, total: 0 }
  const totalStart = performance.now()
  timed(metrics, 'rotateBackups', () => {
    const primary = readFileSync(path)
    parseStore(primary.toString('utf8'))
    let previous
    try {
      previous = readFileSync(`${path}.bak`)
      parseStore(previous.toString('utf8'))
    } catch {
      previous = undefined
    }
    if (previous) atomicWriteFile(`${path}.bak2`, previous)
    atomicWriteFile(`${path}.bak`, primary)
  })
  const serialized = timed(metrics, 'stringify', () => JSON.stringify(store, null, 2))
  timed(metrics, 'atomicWriteFile', () => atomicWriteFile(path, serialized))
  metrics.total = performance.now() - totalStart
  return metrics
}

function currentPersist(store, cache, durable) {
  const metrics = { rotateBackups: 0, stringify: 0, atomicWriteFile: 0, total: 0 }
  const totalStart = performance.now()
  timed(metrics, 'rotateBackups', () => {
    if (cache.backup) atomicWriteFile(`${path}.bak2`, cache.backup, { fsync: durable })
    if (cache.primary) atomicWriteFile(`${path}.bak`, cache.primary, { fsync: durable })
    cache.backup = cache.primary
  })
  const serialized = timed(metrics, 'stringify', () => JSON.stringify(store))
  timed(metrics, 'atomicWriteFile', () => atomicWriteFile(path, serialized, { fsync: durable }))
  cache.primary = serialized
  metrics.total = performance.now() - totalStart
  return metrics
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

function summarize(rows) {
  const keys = ['rotateBackups', 'stringify', 'atomicWriteFile', 'total']
  return Object.fromEntries(keys.map((key) => {
    const values = rows.map((row) => row[key])
    return [key, {
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      max: Math.max(...values)
    }]
  }))
}

function runCase(name, store, fn) {
  const rows = []
  for (let i = 0; i < warmup + samples; i++) {
    store.sessions[0].lastPromptAt += 1
    const metrics = fn()
    if (i >= warmup) rows.push(metrics)
  }
  return { name, summary: summarize(rows) }
}

function print(result) {
  console.log(`\n${result.name}`)
  for (const [phase, stats] of Object.entries(result.summary)) {
    console.log(
      `${phase.padEnd(16)} median ${stats.median.toFixed(2)} ms  p90 ${stats.p90.toFixed(2)} ms  max ${stats.max.toFixed(2)} ms`
    )
  }
}

rmSync(root, { recursive: true, force: true })
const store = makeStore()
const compactBytes = Buffer.byteLength(JSON.stringify(store))
console.log(`Store size: ${compactBytes} bytes (${store.sessions.length} sessions)`)
console.log(`Warmup: ${warmup}, samples: ${samples}`)

seedFiles(store, true)
print(runCase('before: legacy pretty + primary re-read + durable fsync', store, () => legacyPersist(store)))

const primary = seedFiles(store, false)
const durableCache = { primary, backup: readFileSync(`${path}.bak`, 'utf8') }
print(runCase('after: compact + cached backups + durable fsync', store, () => currentPersist(store, durableCache, true)))

const routinePrimary = seedFiles(store, false)
const routineCache = { primary: routinePrimary, backup: readFileSync(`${path}.bak`, 'utf8') }
print(runCase('after routine: compact + cached backups + no fsync', store, () => currentPersist(store, routineCache, false)))

rmSync(root, { recursive: true, force: true })
