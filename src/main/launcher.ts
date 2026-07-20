// launcher.ts — starts/stops a project's local dev server and hands back a URL.
// Faithful port of ~/project-tracker/lib/launcher.mjs. Keeps an in-memory
// registry of spawned dev servers; nothing is persisted. The caller (main IPC)
// resolves each project's cwd + launch metadata and passes them in.

import net from 'node:net'
import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Framework, Launch, LaunchResult, RunningServer } from '../shared/tracker'

interface Rec {
  id: string
  child: ChildProcess
  pid: number
  port: number | null
  url: string | null
  framework: Framework
  label: string
  startedAt: number
  log: string
  status: 'starting' | 'running' | 'exited'
  external?: boolean
  exitCode?: number | null
}

const running = new Map<string, Rec>()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function probe(port: number, timeoutMs = 900): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

function buildCommand(framework: Framework, port: number | null, launch: Launch): { cmd: string; args: string[] } | null {
  switch (framework) {
    case 'next':
      return { cmd: 'npm', args: ['run', 'dev', '--', '-p', String(port)] }
    case 'vite':
      return { cmd: 'npm', args: ['run', 'dev', '--', '--port', String(port), '--strictPort'] }
    case 'electron':
      return { cmd: 'npm', args: ['run', 'dev'] }
    case 'static':
      return { cmd: 'python3', args: ['-m', 'http.server', String(port)] }
    case 'node':
      return { cmd: 'npm', args: ['run', launch.cmdPreview?.includes('run dev') ? 'dev' : 'start'] }
    default:
      return null
  }
}

function view(r: Rec): RunningServer & { external?: boolean } {
  return { id: r.id, label: r.label, port: r.port, url: r.url, framework: r.framework, status: r.status, startedAt: r.startedAt, pid: r.pid, external: !!r.external }
}

export function status(): RunningServer[] {
  return [...running.values()].map(view)
}

export function getRunning(id: string): (RunningServer & { external?: boolean }) | null {
  const r = running.get(id)
  return r ? view(r) : null
}

// If a dev server refused to start because one is already running (Next 16 /
// Turbopack is single-instance per dir), recover the existing port from the log
// and adopt it as an external server we can link to but must not kill.
async function recoverFromLog(rec: Rec, skipPort: number | null): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 300))
  const ports = [...new Set((rec.log.match(/localhost:(\d+)/gi) || []).map((m) => Number(m.split(':')[1])))]
  for (const port of ports) {
    if (port === skipPort) continue
    if (await probe(port)) {
      rec.port = port
      rec.url = `http://localhost:${port}/`
      rec.status = 'running'
      rec.external = true
      return true
    }
  }
  return false
}

export async function launch(id: string, cwd: string | null, label: string, launchMeta: Launch): Promise<LaunchResult> {
  const existing = running.get(id)
  if (existing && existing.status !== 'exited') {
    return { ok: true, already: true, ...getRunning(id)! }
  }
  if (!cwd) return { ok: false, error: 'No local folder mapped for this project.' }
  if (!launchMeta.launchable) return { ok: false, error: 'No dev server detected for this project.' }

  const framework = launchMeta.framework
  const opensUrl = launchMeta.opensUrl
  const forcedPort = framework === 'next' || framework === 'vite' || framework === 'static' ? await freePort() : null

  const spec = buildCommand(framework, forcedPort, launchMeta)
  if (!spec) return { ok: false, error: `Don't know how to launch framework "${framework}".` }

  const env: NodeJS.ProcessEnv = { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' }
  if (forcedPort) env.PORT = String(forcedPort)

  let child: ChildProcess
  try {
    child = spawn(spec.cmd, spec.args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { ok: false, error: `Failed to spawn ${spec.cmd}: ${err instanceof Error ? err.message : String(err)}` }
  }

  const rec: Rec = {
    id,
    child,
    pid: child.pid ?? 0,
    port: forcedPort,
    url: null,
    framework,
    label,
    startedAt: Date.now(),
    log: '',
    status: 'starting'
  }
  running.set(id, rec)

  const capture = (buf: Buffer): void => {
    rec.log = (rec.log + buf.toString()).slice(-8000)
    if (!forcedPort) {
      const m = rec.log.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/i)
      if (m) rec.port = Number(m[1])
    }
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.on('exit', (code) => {
    rec.status = 'exited'
    rec.exitCode = code
  })

  // Electron (or anything with no URL) — launched once the process is up.
  if (!opensUrl) {
    await new Promise((r) => setTimeout(r, 1200))
    if (rec.status === 'exited') {
      return { ok: false, error: 'Process exited immediately.', log: rec.log.slice(-1200) }
    }
    rec.status = 'running'
    return { ok: true, ...getRunning(id)!, note: 'Desktop app — no browser URL.' }
  }

  // Poll for the port to accept connections.
  const deadline = Date.now() + 55000
  while (Date.now() < deadline) {
    if (rec.status === 'exited') {
      if (await recoverFromLog(rec, forcedPort)) {
        return { ok: true, already: true, ...getRunning(id)!, note: 'Already running outside the tracker — linked to it.' }
      }
      return { ok: false, error: 'Dev server exited during startup.', log: rec.log.slice(-1500) }
    }
    if (rec.port && (await probe(rec.port))) {
      rec.url = `http://localhost:${rec.port}/`
      rec.status = 'running'
      return { ok: true, ...getRunning(id)! }
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  // Timed out waiting — leave it running; the UI can retry status.
  rec.status = rec.port ? 'running' : 'starting'
  if (rec.port) rec.url = `http://localhost:${rec.port}/`
  return { ok: true, slow: true, ...getRunning(id)!, note: 'Still compiling — try the link in a moment.', log: rec.log.slice(-800) }
}

export function stop(id: string): { ok: boolean; external?: boolean; error?: string } {
  const rec = running.get(id)
  if (!rec) return { ok: false, error: 'Not running.' }
  if (rec.external) {
    running.delete(id)
    return { ok: true, external: true }
  }
  try {
    // kill the whole process group (spawned detached)
    process.kill(-rec.pid, 'SIGTERM')
  } catch {
    try {
      process.kill(rec.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  running.delete(id)
  return { ok: true }
}

export function stopAll(): void {
  for (const id of [...running.keys()]) stop(id)
}
