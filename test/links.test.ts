import { describe, it, expect } from 'vitest'
import {
  findUrls,
  findTerminalLinks,
  isUrlToken,
  normalizeUrl,
  wrappedGroupAt,
  rangeForMatch,
  type BufferLike
} from '../src/shared/links'

describe('findUrls', () => {
  it('finds a bare http URL', () => {
    const line = 'Server listening on http://localhost:3000/ now'
    expect(findUrls(line)).toEqual([
      { text: 'http://localhost:3000/', start: 20, end: 42 }
    ])
  })

  it('finds an https URL with a path and query', () => {
    const [m] = findUrls('see https://github.com/a/b/pull/53?w=1 for detail')
    expect(m.text).toBe('https://github.com/a/b/pull/53?w=1')
  })

  it('drops a trailing full stop', () => {
    const [m] = findUrls('docs at https://crew.dev/docs.')
    expect(m.text).toBe('https://crew.dev/docs')
  })

  it('drops a trailing closing bracket', () => {
    const [m] = findUrls('(https://crew.dev/a)')
    expect(m.text).toBe('https://crew.dev/a')
  })

  it('matches a www host without a scheme', () => {
    expect(findUrls('try www.example.com today')[0].text).toBe('www.example.com')
  })

  it('ignores a scheme with no host', () => {
    expect(findUrls('https:// is a prefix')).toEqual([])
  })

  it('ignores prose that merely contains a dot', () => {
    expect(findUrls('rebuilt pool.ts and engine.ts')).toEqual([])
  })

  it('finds several URLs on one line', () => {
    expect(findUrls('a https://x.dev b https://y.dev c')).toHaveLength(2)
  })

  it('is bounded per line', () => {
    const line = Array.from({ length: 40 }, (_, i) => `https://x${i}.dev`).join(' ')
    expect(findUrls(line)).toHaveLength(20)
  })
})

describe('findTerminalLinks', () => {
  it('returns a bare URL as a link', () => {
    expect(findTerminalLinks('open https://crew.dev/x')[0].text).toBe('https://crew.dev/x')
  })

  it('still returns previewable file paths', () => {
    const got = findTerminalLinks('wrote ./out/shot.png')
    expect(got.map((m) => m.text)).toEqual(['./out/shot.png'])
  })

  it('does not preview an image path that is part of a URL', () => {
    const got = findTerminalLinks('see https://site.com/img/a.png now')
    expect(got.map((m) => m.text)).toEqual(['https://site.com/img/a.png'])
  })

  it('returns matches in line order', () => {
    const got = findTerminalLinks('./a.png then https://crew.dev/b')
    expect(got.map((m) => m.text)).toEqual(['./a.png', 'https://crew.dev/b'])
  })
})

describe('isUrlToken / normalizeUrl', () => {
  it('classifies tokens', () => {
    expect(isUrlToken('https://x.dev')).toBe(true)
    expect(isUrlToken('www.x.dev')).toBe(true)
    expect(isUrlToken('./a.png')).toBe(false)
  })

  it('adds a scheme only when missing', () => {
    expect(normalizeUrl('www.x.dev')).toBe('https://www.x.dev')
    expect(normalizeUrl('http://x.dev')).toBe('http://x.dev')
  })
})

/** A buffer of fixed-width rows; `wrapped` lists rows that continue the one above. */
function fakeBuffer(rows: string[], cols: number, wrapped: number[] = []): BufferLike {
  return {
    length: rows.length,
    getLine: (y) =>
      y < 0 || y >= rows.length
        ? undefined
        : {
            isWrapped: wrapped.includes(y),
            translateToString: (trim?: boolean) =>
              trim ? rows[y].replace(/\s+$/, '') : rows[y].padEnd(cols, ' ')
          }
  }
}

describe('wrappedGroupAt', () => {
  it('returns a single row when nothing is wrapped', () => {
    const buf = fakeBuffer(['hello', 'world'], 10)
    expect(wrappedGroupAt(buf, 1)).toEqual({ firstRow: 1, text: 'world     ' })
  })

  it('joins a wrapped continuation into one logical line', () => {
    const buf = fakeBuffer(['https://x.', 'dev/a/b'], 10, [1])
    expect(wrappedGroupAt(buf, 0)?.text).toBe('https://x.dev/a/b   ')
  })

  it('finds the start of the group from a continuation row', () => {
    const buf = fakeBuffer(['https://x.', 'dev/a/b'], 10, [1])
    expect(wrappedGroupAt(buf, 1)?.firstRow).toBe(0)
  })

  it('stops at the next unwrapped row', () => {
    const buf = fakeBuffer(['abc', 'def', 'ghi'], 3, [1])
    expect(wrappedGroupAt(buf, 0)?.text).toBe('abcdef')
  })

  it('returns nothing for a row outside the buffer', () => {
    expect(wrappedGroupAt(fakeBuffer(['a'], 3), 5)).toBeUndefined()
  })

  it('bounds how many rows one logical line may span', () => {
    const rows = Array.from({ length: 40 }, () => 'abc')
    const wrapped = rows.map((_, i) => i).slice(1)
    expect(wrappedGroupAt(fakeBuffer(rows, 3, wrapped), 0)?.text.length).toBe(36)
  })

  it('reassembles a URL split across rows so it can be matched at all', () => {
    const buf = fakeBuffer(['go to https://cr', 'ew.dev/releases'], 16, [1])
    const group = wrappedGroupAt(buf, 0)!
    expect(findUrls(group.text)[0].text).toBe('https://crew.dev/releases')
  })
})

describe('rangeForMatch', () => {
  it('maps an offset on the first row to 1-based coordinates', () => {
    expect(rangeForMatch(2, 5, 80, 0)).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 5, y: 1 }
    })
  })

  it('maps a match that spans a wrap onto two rows', () => {
    // cols 16, match covers offsets 6..31 of the logical line.
    expect(rangeForMatch(6, 31, 16, 0)).toEqual({
      start: { x: 7, y: 1 },
      end: { x: 15, y: 2 }
    })
  })

  it('offsets by the row the logical line starts on', () => {
    expect(rangeForMatch(0, 3, 80, 7).start).toEqual({ x: 1, y: 8 })
  })

  it('never produces an end before the start for an empty range', () => {
    const r = rangeForMatch(4, 4, 80, 0)
    expect(r.end).toEqual(r.start)
  })
})

describe('findUrls on the links agents actually print', () => {
  it('links a localhost dev server', () => {
    expect(findUrls('  ➜  Local:   http://localhost:5173/')[0].text).toBe(
      'http://localhost:5173/'
    )
  })

  it('links a loopback IP with a port', () => {
    expect(findUrls('listening on http://127.0.0.1:3000')[0].text).toBe('http://127.0.0.1:3000')
  })

  it('does not link a bare host with no scheme', () => {
    expect(findUrls('connect to localhost:5173')).toEqual([])
  })
})
