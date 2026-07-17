import { describe, expect, it } from 'vitest'
import {
  assetExt,
  assetKind,
  assetMime,
  assetUrl,
  findAssetPaths,
  isIgnoredDir,
  isIgnoredRelPath
} from '../src/shared/assets'

describe('assetKind', () => {
  it('classifies previewable extensions', () => {
    expect(assetKind('shot.png')).toBe('image')
    expect(assetKind('Photo.JPEG')).toBe('image')
    expect(assetKind('logo.svg')).toBe('image')
    expect(assetKind('index.html')).toBe('html')
    expect(assetKind('doc.pdf')).toBe('pdf')
    expect(assetKind('demo.mp4')).toBe('video')
    expect(assetKind('voice.mp3')).toBe('audio')
  })

  it('rejects non-assets and extension-less names', () => {
    expect(assetKind('main.ts')).toBeNull()
    expect(assetKind('Makefile')).toBeNull()
    expect(assetKind('.env')).toBeNull()
    expect(assetKind('.png')).toBeNull() // dotfile, not an extension
  })

  it('uses only the basename', () => {
    expect(assetKind('a.png/b.ts')).toBeNull()
    expect(assetExt('dir.v2/file.PNG')).toBe('png')
  })
})

describe('assetMime', () => {
  it('maps known extensions', () => {
    expect(assetMime('a.svg')).toBe('image/svg+xml')
    expect(assetMime('a.html')).toBe('text/html')
  })
  it('falls back to octet-stream', () => {
    expect(assetMime('a.xyz')).toBe('application/octet-stream')
  })
})

describe('ignore rules', () => {
  it('ignores heavy/system directories and dot-dirs', () => {
    expect(isIgnoredDir('node_modules')).toBe(true)
    expect(isIgnoredDir('.git')).toBe(true)
    expect(isIgnoredDir('src')).toBe(false)
  })

  it('skips build-output dirs during the scan but allows them for live watch events', () => {
    // Bulk scan skips them (avoid flooding with pre-existing build artifacts)…
    expect(isIgnoredDir('dist')).toBe(true)
    expect(isIgnoredDir('out')).toBe(true)
    // …but a freshly generated asset written into them should still appear.
    expect(isIgnoredRelPath('dist/poster.png')).toBe(false)
    expect(isIgnoredRelPath('out/assets/hero.png')).toBe(false)
  })

  it('checks every directory segment of a relative path', () => {
    expect(isIgnoredRelPath('node_modules/pkg/logo.png')).toBe(true)
    expect(isIgnoredRelPath('src/.cache/x.png')).toBe(true)
    expect(isIgnoredRelPath('docs/img/x.png')).toBe(false)
    expect(isIgnoredRelPath('docs/.hidden.png')).toBe(true)
    expect(isIgnoredRelPath('x.png')).toBe(false)
  })
})

describe('assetUrl', () => {
  it('encodes the absolute path', () => {
    expect(assetUrl('/tmp/a b.png')).toBe('crew-asset://local/%2Ftmp%2Fa%20b.png')
  })
})

describe('findAssetPaths', () => {
  const texts = (line: string): string[] => findAssetPaths(line).map((m) => m.text)

  it('finds absolute, homedir, dotted and bare relative paths', () => {
    expect(texts('Wrote /tmp/out/shot.png and ~/Desktop/pic.jpg')).toEqual([
      '/tmp/out/shot.png',
      '~/Desktop/pic.jpg'
    ])
    expect(texts('Created ./dist/index.html!')).toEqual(['./dist/index.html'])
    expect(texts('open preview.html or assets/logo.svg')).toEqual([
      'preview.html',
      'assets/logo.svg'
    ])
  })

  it('reports correct 0-based [start, end) offsets', () => {
    const line = 'saved to out/a.png done'
    const [m] = findAssetPaths(line)
    expect(line.slice(m.start, m.end)).toBe('out/a.png')
  })

  it('ignores non-asset files and URL bodies', () => {
    expect(texts('edited src/main.ts and ran make')).toEqual([])
    expect(texts('see https://example.com/a.png')).toEqual([])
  })

  it('handles multiple matches on one line', () => {
    expect(texts('a.png b.png')).toEqual(['a.png', 'b.png'])
  })
})
