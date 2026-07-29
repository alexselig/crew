import { describe, it, expect } from 'vitest'
import { parseCopilotEvents, type AgentBlock } from '../src/shared/agent-events'

// Synthetic events shaped exactly like Copilot CLI's events.jsonl (verified
// against real logs); no real conversation content is used.
function line(type: string, data: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({ type, id: crypto.randomUUID(), timestamp: '2026-07-01T04:26:36.824Z', data, ...extra })
}

const PNG = 'iVBORw0KGgoAAAANS' // stand-in base64 payload

function kinds(bs: AgentBlock[]): string[] {
  return bs.map((b) => b.kind)
}

describe('parseCopilotEvents', () => {
  it('maps a user prompt to a user block (raw content, not transformed)', () => {
    const jsonl = line('user.message', {
      content: '/autopilot on',
      transformedContent: 'a much longer expanded version with context…'
    })
    const [b] = parseCopilotEvents(jsonl)
    expect(b.kind).toBe('user')
    expect(b.kind === 'user' && b.text).toBe('/autopilot on')
  })

  it('emits a thinking block then an agent block for an assistant message', () => {
    const jsonl = line('assistant.message', {
      content: 'Done — tests pass.',
      reasoningText: 'The failure was a null deref in the parser.'
    })
    const bs = parseCopilotEvents(jsonl)
    expect(kinds(bs)).toEqual(['thinking', 'agent'])
    expect(bs[0].kind === 'thinking' && bs[0].body).toMatch(/null deref/)
    expect(bs[1].kind === 'agent' && bs[1].text).toBe('Done — tests pass.')
  })

  it('skips an assistant message with no prose and no reasoning', () => {
    const jsonl = line('assistant.message', { content: '', reasoningText: '' })
    expect(parseCopilotEvents(jsonl)).toHaveLength(0)
  })

  it('builds one tool block from start+complete with command, output, exit, duration', () => {
    const callId = 'call_123'
    const jsonl = [
      JSON.stringify({
        type: 'tool.execution_start',
        id: '1',
        timestamp: '2026-07-01T04:26:36.000Z',
        data: { toolCallId: callId, toolName: 'bash', arguments: { command: 'npm test', description: 'run tests' } }
      }),
      JSON.stringify({
        type: 'tool.execution_complete',
        id: '2',
        timestamp: '2026-07-01T04:26:38.500Z',
        data: { toolCallId: callId, success: true, result: { content: 'All 42 tests passed' } }
      })
    ].join('\n')
    const bs = parseCopilotEvents(jsonl)
    expect(bs).toHaveLength(1)
    const b = bs[0]
    expect(b.kind).toBe('tool')
    if (b.kind === 'tool') {
      expect(b.command).toBe('npm test')
      expect(b.output).toBe('All 42 tests passed')
      expect(b.exitCode).toBe(0)
      expect(b.durationMs).toBe(2500)
    }
  })

  it('marks a failed tool with a non-zero exit code', () => {
    const callId = 'c2'
    const jsonl = [
      line('tool.execution_start', { toolCallId: callId, toolName: 'bash', arguments: { command: 'false' } }),
      line('tool.execution_complete', { toolCallId: callId, success: false, result: { content: 'boom' } })
    ].join('\n')
    const [b] = parseCopilotEvents(jsonl)
    expect(b.kind === 'tool' && b.exitCode).toBe(1)
  })

  it('labels a non-shell tool from its name + path argument', () => {
    const jsonl = line('tool.execution_start', {
      toolCallId: 'v1',
      toolName: 'view',
      arguments: { path: '/tmp/x.png' }
    })
    const [b] = parseCopilotEvents(jsonl)
    expect(b.kind === 'tool' && b.command).toBe('view /tmp/x.png')
  })

  it('inlines a tool-produced image as a data URI (asset linked by id)', () => {
    const assetId = 'asset_abc'
    const jsonl = [
      line('session.binary_asset', {
        assetId,
        type: 'image',
        mimeType: 'image/png',
        byteLength: 1024,
        data: PNG,
        description: 'Image file at path /tmp/shot.png'
      }),
      line('tool.execution_start', { toolCallId: 't1', toolName: 'view', arguments: { path: '/tmp/shot.png' } }),
      line('tool.execution_complete', {
        toolCallId: 't1',
        success: true,
        result: {
          content: 'viewed image',
          binaryResultsForLlm: [{ type: 'image', assetId, mimeType: 'image/png', byteLength: 1024 }]
        }
      })
    ].join('\n')
    const bs = parseCopilotEvents(jsonl)
    const img = bs.find((b) => b.kind === 'image')
    expect(img).toBeTruthy()
    if (img && img.kind === 'image') {
      expect(img.src).toBe(`data:image/png;base64,${PNG}`)
      expect(img.caption).toBe('shot.png')
    }
  })

  it('falls back to a file:// path when an image exceeds the inline size cap', () => {
    const assetId = 'big'
    const jsonl = [
      line('session.binary_asset', {
        assetId,
        type: 'image',
        mimeType: 'image/png',
        byteLength: 50 * 1024 * 1024,
        data: PNG,
        description: 'Image file at path /tmp/huge.png'
      }),
      line('tool.execution_complete', {
        toolCallId: 't2',
        success: true,
        result: { content: 'x', binaryResultsForLlm: [{ type: 'image', assetId, mimeType: 'image/png' }] }
      })
    ].join('\n')
    const img = parseCopilotEvents(jsonl, { maxSingleImageBytes: 4 * 1024 * 1024 }).find((b) => b.kind === 'image')
    expect(img && img.kind === 'image' && img.src).toBe('file:///tmp/huge.png')
  })

  it('inlines a user image attachment as file://', () => {
    const jsonl = line('user.message', {
      content: 'look at this',
      attachments: [{ type: 'file', path: '/Users/a/Desktop/Screenshot.png', displayName: 'Screenshot.png' }]
    })
    const bs = parseCopilotEvents(jsonl)
    expect(kinds(bs)).toEqual(['user', 'image'])
    const img = bs[1]
    expect(img.kind === 'image' && img.src).toBe('file:///Users/a/Desktop/Screenshot.png')
    expect(img.kind === 'image' && img.caption).toBe('Screenshot.png')
  })

  it('ignores non-image attachments', () => {
    const jsonl = line('user.message', {
      content: 'a doc',
      attachments: [{ type: 'file', path: '/tmp/report.pdf', displayName: 'report.pdf' }]
    })
    expect(kinds(parseCopilotEvents(jsonl))).toEqual(['user'])
  })

  it('does not emit the same image asset twice', () => {
    const assetId = 'once'
    const jsonl = [
      line('session.binary_asset', { assetId, mimeType: 'image/png', byteLength: 10, data: PNG, description: 'Image file at path /tmp/a.png' }),
      line('tool.execution_complete', { toolCallId: 'a', success: true, result: { content: '', binaryResultsForLlm: [{ assetId, mimeType: 'image/png' }] } }),
      line('tool.execution_complete', { toolCallId: 'b', success: true, result: { content: '', binaryResultsForLlm: [{ assetId, mimeType: 'image/png' }] } })
    ].join('\n')
    expect(parseCopilotEvents(jsonl).filter((b) => b.kind === 'image')).toHaveLength(1)
  })

  it('captures a permission request and its resolution', () => {
    const jsonl = [
      line('permission.requested', {
        requestId: 'r1',
        permissionRequest: { kind: 'web', intention: 'fetch https://example.com', toolCallId: 'tc' }
      }),
      line('permission.completed', { requestId: 'r1', toolCallId: 'tc', result: { kind: 'approved' } })
    ].join('\n')
    const bs = parseCopilotEvents(jsonl)
    expect(bs).toHaveLength(1)
    const b = bs[0]
    expect(b.kind).toBe('permission')
    if (b.kind === 'permission') {
      expect(b.command).toBe('fetch https://example.com')
      expect(b.resolution).toBe('once')
    }
  })

  it('marks a denied permission', () => {
    const jsonl = [
      line('permission.requested', { requestId: 'r2', permissionRequest: { intention: 'rm -rf', toolCallId: 't' } }),
      line('permission.completed', { requestId: 'r2', result: { kind: 'denied' } })
    ].join('\n')
    const [b] = parseCopilotEvents(jsonl)
    expect(b.kind === 'permission' && b.resolution).toBe('deny')
  })

  it('skips malformed and blank lines without throwing', () => {
    const jsonl = ['', 'not json', '{bad', line('user.message', { content: 'hi' }), '   '].join('\n')
    const bs = parseCopilotEvents(jsonl)
    expect(kinds(bs)).toEqual(['user'])
  })

  it('ignores system, session, and turn bookkeeping events', () => {
    const jsonl = [
      line('session.start', {}),
      line('assistant.turn_start', {}),
      line('system.message', { role: 'system', content: 'huge system prompt' }),
      line('assistant.turn_end', {}),
      line('session.shutdown', {})
    ].join('\n')
    expect(parseCopilotEvents(jsonl)).toHaveLength(0)
  })

  it('keeps only the most recent maxBlocks', () => {
    const many = Array.from({ length: 20 }, (_, i) => line('user.message', { content: `m${i}` })).join('\n')
    const bs = parseCopilotEvents(many, { maxBlocks: 5 })
    expect(bs).toHaveLength(5)
    expect(bs[bs.length - 1].kind === 'user' && (bs[bs.length - 1] as { text: string }).text).toBe('m19')
  })

  it('truncates over-long text to maxText', () => {
    const big = 'x'.repeat(5000)
    const [b] = parseCopilotEvents(line('user.message', { content: big }), { maxText: 100 })
    expect(b.kind === 'user' && b.text.length).toBeLessThan(200)
    expect(b.kind === 'user' && b.text).toMatch(/more chars/)
  })

  it('parses ISO timestamps into epoch ms', () => {
    const [b] = parseCopilotEvents(line('user.message', { content: 'hi' }))
    expect(b.ts).toBe(Date.parse('2026-07-01T04:26:36.824Z'))
  })
})
