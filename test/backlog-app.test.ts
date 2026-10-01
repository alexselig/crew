import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SERVER = resolve(__dirname, '..', 'backlog', 'server.js')

type Harness = { base: string; file: string; child: ChildProcessWithoutNullStreams }

const running: Harness[] = []
const directories: string[] = []
afterEach(() => {
  for (const h of running.splice(0)) h.child.kill()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function backlogDoc() {
  return {
    title: 'Test backlog',
    order: ['CB-1', 'CB-2', 'CB-3'],
    items: [
      { id: 'CB-1', title: 'First', detail: 'd1', group: 'Area', size: 'Small' },
      { id: 'CB-2', title: 'Second' },
      { id: 'CB-3', title: 'Third' }
    ],
    state: {}
  }
}

/** Boot the server on an ephemeral port and resolve once it reports its URL. */
async function start(doc: unknown = backlogDoc()): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'crew-backlog-'))
  directories.push(dir)
  const file = join(dir, 'backlog.json')
  writeFileSync(file, JSON.stringify(doc, null, 2))

  const child = spawn(process.execPath, [SERVER, '--file', file, '--port', '0'], { stdio: 'pipe' })
  const base = await new Promise<string>((resolveUrl, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10_000)
    child.stderr.on('data', (chunk) => { out += String(chunk) })
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out)
      if (match) {
        clearTimeout(timer)
        resolveUrl(`http://127.0.0.1:${match[1]}`)
      }
    })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}: ${out}`)) })
  })

  const harness = { base, file, child }
  running.push(harness)
  return harness
}

const post = (h: Harness, path: string, body: unknown, origin?: string) =>
  fetch(h.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body)
  })

const read = (h: Harness) => JSON.parse(readFileSync(h.file, 'utf8'))

describe('backlog app', () => {
  it('renders one card per item in ranked order', async () => {
    const h = await start()
    const html = await (await fetch(h.base + '/')).text()
    expect(html.match(/class="card"/g)).toHaveLength(3)
    expect(html.indexOf('CB-1')).toBeLessThan(html.indexOf('CB-2'))
  })

  it('renders in the persisted order, not the items order', async () => {
    const h = await start({ ...backlogDoc(), order: ['CB-3', 'CB-1', 'CB-2'] })
    const html = await (await fetch(h.base + '/')).text()
    expect(html.indexOf('CB-3')).toBeLessThan(html.indexOf('CB-1'))
  })

  it('appends items missing from order rather than dropping them', async () => {
    const h = await start({ ...backlogDoc(), order: ['CB-2'] })
    const html = await (await fetch(h.base + '/')).text()
    expect(html.match(/class="card"/g)).toHaveLength(3)
    expect(await (await fetch(h.base + '/api/backlog')).json())
      .toMatchObject({ order: ['CB-2', 'CB-1', 'CB-3'] })
  })

  it('persists a reorder', async () => {
    const h = await start()
    expect((await post(h, '/api/order', { order: ['CB-3', 'CB-2', 'CB-1'] })).status).toBe(200)
    expect(read(h).order).toEqual(['CB-3', 'CB-2', 'CB-1'])
  })

  it('rejects an order that is not a permutation of the known ids', async () => {
    const h = await start()
    for (const order of [['CB-1'], ['CB-1', 'CB-1', 'CB-2'], ['CB-1', 'CB-2', 'CB-9']]) {
      expect((await post(h, '/api/order', { order })).status).toBe(400)
    }
    expect(read(h).order).toEqual(['CB-1', 'CB-2', 'CB-3'])
  })

  it('records a status and a note', async () => {
    const h = await start()
    await post(h, '/api/item', { id: 'CB-2', status: 'approved', note: 'ship it' })
    expect(read(h).state['CB-2']).toMatchObject({ status: 'approved', note: 'ship it' })
  })

  it('clears the entry when both status and note are empty', async () => {
    const h = await start()
    await post(h, '/api/item', { id: 'CB-2', status: 'declined' })
    await post(h, '/api/item', { id: 'CB-2', status: null, note: '' })
    expect(read(h).state['CB-2']).toBeUndefined()
  })

  it('rejects an unknown status or id', async () => {
    const h = await start()
    expect((await post(h, '/api/item', { id: 'CB-1', status: 'maybe' })).status).toBe(400)
    expect((await post(h, '/api/item', { id: 'CB-9', status: 'approved' })).status).toBe(404)
  })

  it('adds an item with the next free id and ranks it last', async () => {
    const h = await start()
    const res = await post(h, '/api/new', { title: 'Fourth', why: 'because' })
    expect(await res.json()).toMatchObject({ ok: true, id: 'CB-4' })
    const doc = read(h)
    expect(doc.order).toEqual(['CB-1', 'CB-2', 'CB-3', 'CB-4'])
    expect(doc.items.at(-1)).toEqual({ id: 'CB-4', title: 'Fourth', why: 'because' })
  })

  it('requires a title to add an item', async () => {
    const h = await start()
    expect((await post(h, '/api/new', { title: '   ' })).status).toBe(400)
    expect(read(h).items).toHaveLength(3)
  })

  it('rejects writes from a foreign origin', async () => {
    const h = await start()
    for (const path of ['/api/order', '/api/item', '/api/new']) {
      expect((await post(h, path, {}, 'http://evil.test')).status).toBe(403)
    }
    expect(read(h).state).toEqual({})
  })

  it('escapes item text on the way into the page', async () => {
    const h = await start({
      ...backlogDoc(),
      items: [{ id: 'CB-1', title: '<script>alert(1)</script>' }],
      order: ['CB-1']
    })
    const html = await (await fetch(h.base + '/')).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('refuses to start on duplicate ids rather than merging two cards', async () => {
    await expect(start({
      ...backlogDoc(),
      items: [{ id: 'CB-1', title: 'a' }, { id: 'CB-1', title: 'b' }],
      order: ['CB-1']
    })).rejects.toThrow(/duplicate ids/)
  })
})
