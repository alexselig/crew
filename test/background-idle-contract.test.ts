import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
const measurement = readFileSync(
  new URL('../docs/performance/background-idle-measurement.md', import.meta.url),
  'utf8'
)

describe('background idle performance contract', () => {
  it('pauses decorative motion under the renderer inactive class', () => {
    expect(css).toContain('.crew-inactive *,')
    expect(css).toContain('animation-play-state: paused !important')
    expect(css).toContain('transition: none !important')
  })

  it('documents every signed-app acceptance check', () => {
    expect(measurement).toContain('at least 80%')
    expect(measurement).toContain('30-second median below 5%')
    expect(measurement).toContain('Needs-you')
    expect(measurement).toContain('recent output')
    expect(measurement).toContain('signed')
    expect(measurement).toContain('Do not launch')
    expect(measurement).toContain('ps -axo pid=,comm=')
    expect(measurement).toContain('pid=$1')
    expect(measurement).toContain('executable=$0')
    expect(measurement).toContain('sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", executable)')
    expect(measurement).toContain('index(executable, app) == 1')
    expect(measurement).toContain('foreground.tsv')
    expect(measurement).toContain('background.tsv')
    expect(measurement).toContain('sample 5')
  })
})
