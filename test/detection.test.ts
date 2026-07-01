import { describe, it, expect } from 'vitest'
import {
  StateDetector,
  stripAnsi,
  DEFAULT_SPINNER_REGEX,
  type DetectionConfig
} from '../src/shared/detection'
import type { SessionState } from '../src/shared/types'

function makeDetector(cfg: Partial<DetectionConfig> = {}, startAt = 0) {
  const states: SessionState[] = []
  const full: DetectionConfig = {
    quietMs: 800,
    confirmMs: 0,
    assumeWaitingAfterMs: 1500,
    inputGraceMs: 2500,
    promptRegex: null,
    approvalRegex: null,
    spinnerRegex: null,
    ...cfg
  }
  const det = new StateDetector(startAt, full, (s) => states.push(s))
  return { det, states }
}

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('\u001B[31mhello\u001B[0m')).toBe('hello')
  })
  it('removes OSC sequences (title / hyperlink)', () => {
    expect(stripAnsi('\u001B]0;my title\u0007text')).toBe('text')
  })
  it('removes cursor-movement CSI and carriage returns are preserved as text', () => {
    expect(stripAnsi('a\u001B[2Kb')).toBe('ab')
  })
})

describe('StateDetector', () => {
  it('starts in STARTING and does not emit spuriously', () => {
    const { det, states } = makeDetector()
    expect(det.state).toBe('STARTING')
    expect(states).toEqual([])
  })

  it('goes WORKING as soon as output flows', () => {
    const { det, states } = makeDetector()
    det.pushOutput('thinking...', 10)
    expect(det.state).toBe('WORKING')
    expect(states).toEqual(['WORKING'])
  })

  it('stays WORKING while output keeps streaming (no false quiescence)', () => {
    const { det } = makeDetector({ quietMs: 800 })
    det.pushOutput('a', 0)
    det.tick(500)
    det.pushOutput('b', 700)
    det.tick(1200) // only 500ms since last output
    expect(det.state).toBe('WORKING')
  })

  it('detects WAITING_INPUT via prompt regex after quiescence', () => {
    const { det, states } = makeDetector({ promptRegex: /\n> $/ })
    det.pushOutput('Here is the answer.\n> ', 0)
    expect(det.state).toBe('WORKING')
    det.tick(900) // 900ms of silence > quietMs
    expect(det.state).toBe('WAITING_INPUT')
    expect(states).toEqual(['WORKING', 'WAITING_INPUT'])
  })

  it('detects WAITING_APPROVAL and prefers it over a plain prompt', () => {
    const { det } = makeDetector({
      promptRegex: /> $/,
      approvalRegex: /\(y\/n\)/i
    })
    det.pushOutput('Allow edit to file? (y/n) > ', 0)
    det.tick(900)
    expect(det.state).toBe('WAITING_APPROVAL')
  })

  it('returns to WORKING when new output arrives after waiting', () => {
    const { det } = makeDetector({ promptRegex: /> $/ })
    det.pushOutput('done\n> ', 0)
    det.tick(900)
    expect(det.state).toBe('WAITING_INPUT')
    det.notifyInput(1000) // user typed
    expect(det.state).toBe('WORKING')
    det.pushOutput('working again', 1100)
    expect(det.state).toBe('WORKING')
  })

  it('uses assumeWaitingAfterMs fallback when no prompt regex matches', () => {
    const { det } = makeDetector({
      promptRegex: null,
      quietMs: 800,
      assumeWaitingAfterMs: 1500
    })
    det.pushOutput('some output with no recognizable prompt', 0)
    det.tick(1000) // quiet but < grace period
    expect(det.state).toBe('IDLE')
    det.tick(1600) // past grace period
    expect(det.state).toBe('WAITING_INPUT')
  })

  it('does NOT assume-wait if disabled (stays IDLE)', () => {
    const { det } = makeDetector({ promptRegex: null, assumeWaitingAfterMs: null })
    det.pushOutput('output', 0)
    det.tick(5000)
    expect(det.state).toBe('IDLE')
  })

  it('never flags waiting before any output (still STARTING/quiet)', () => {
    const { det, states } = makeDetector({ assumeWaitingAfterMs: 1500 })
    det.tick(5000) // long silence but never produced output
    expect(det.state).toBe('STARTING')
    expect(states).toEqual([])
  })

  it('marks EXITED / ERROR by exit code and ignores later signals', () => {
    const a = makeDetector()
    a.det.pushOutput('x', 0)
    a.det.markExited(0)
    expect(a.det.state).toBe('EXITED')
    a.det.pushOutput('late', 10) // ignored once terminal
    expect(a.det.state).toBe('EXITED')

    const b = makeDetector()
    b.det.markExited(1)
    expect(b.det.state).toBe('ERROR')
  })

  it('matches prompt against ANSI-decorated output', () => {
    const { det } = makeDetector({ promptRegex: /> $/ })
    det.pushOutput('\u001B[32mdone\u001B[0m\n\u001B[1m> \u001B[0m', 0)
    det.tick(900)
    expect(det.state).toBe('WAITING_INPUT')
  })

  it('does NOT flip to waiting after user input until the agent outputs again', () => {
    // Regression: think-time / tool stall right after your prompt must NOT be
    // misread as "waiting for you" (that would fire a spurious notification).
    const { det } = makeDetector({ assumeWaitingAfterMs: 1200 })
    det.pushOutput('Answer.\n', 0)
    det.tick(1300) // legit: quiet past grace → waiting
    expect(det.state).toBe('WAITING_INPUT')

    det.notifyInput(1400) // user replies
    expect(det.state).toBe('WORKING')
    det.tick(2300) // 900ms of silence — agent is thinking
    det.tick(2700) // 1300ms of silence — WITHOUT the fix this mis-fires WAITING
    expect(det.state).toBe('WORKING')

    det.pushOutput('...more output\n', 2800) // agent responds
    det.tick(4100) // now silence again, past the grace window → legitimately waiting
    expect(det.state).toBe('WAITING_INPUT')
  })

  it('suppresses the silence fallback during the post-input grace window (echo-proof)', () => {
    // Terminal echoes your keystrokes as "output", so the awaiting-output flag
    // alone is not enough; the grace window keeps us WORKING through think-time.
    const { det } = makeDetector({ assumeWaitingAfterMs: 1500, inputGraceMs: 2500 })
    det.pushOutput('> ', 0)
    det.notifyInput(2000) // user submits
    det.pushOutput('hello', 2010) // terminal echo of keystrokes (not a real response)
    det.tick(3600) // 1590ms quiet but only 1600ms since input → still WORKING
    expect(det.state).toBe('WORKING')
    det.tick(4600) // 2590ms quiet AND 2600ms since input → now waiting
    expect(det.state).toBe('WAITING_INPUT')
  })

  it('debounces WAITING with confirmMs (no flicker on a single tick)', () => {
    const { det } = makeDetector({ promptRegex: /> $/, quietMs: 800, confirmMs: 400 })
    det.pushOutput('done\n> ', 0)
    det.tick(900) // quiet, prompt matches, but confirm window not yet elapsed
    expect(det.state).toBe('WORKING')
    det.tick(1000) // still within confirm window (100ms < 400ms)
    expect(det.state).toBe('WORKING')
    det.tick(1350) // 450ms since candidate first held → commit
    expect(det.state).toBe('WAITING_INPUT')
  })

  it('exposes a detection reason', () => {
    const prompt = makeDetector({ promptRegex: /> $/ })
    prompt.det.pushOutput('hi\n> ', 0)
    expect(prompt.det.reason).toBe('streaming')
    prompt.det.tick(900)
    expect(prompt.det.reason).toBe('input-prompt')

    const silent = makeDetector({ promptRegex: null, assumeWaitingAfterMs: 1000 })
    silent.det.pushOutput('unrecognized', 0)
    silent.det.tick(1100)
    expect(silent.det.state).toBe('WAITING_INPUT')
    expect(silent.det.reason).toBe('silence')
  })

  it('stays WORKING across spinner frames (no false waiting between frames)', () => {
    const { det } = makeDetector({ spinnerRegex: DEFAULT_SPINNER_REGEX, quietMs: 800 })
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼']
    let t = 0
    for (const f of frames) {
      det.pushOutput(`\r${f} working…`, t)
      t += 120
      det.tick(t) // ~120ms between frames, well under quietMs
      expect(det.state).toBe('WORKING')
    }
  })
})
